import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { deleteThread, renameThread } from "./app-server-client";

/**
 * Codex's own config root — never overridden by tet (see CLAUDE.md's "never touch the
 * user's agent configuration"), so this is the same location Codex itself resolves to.
 */
function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function sessionsRoot(): string {
  return path.join(codexHome(), "sessions");
}

/** Codex's own name index — `{id, thread_name, updated_at}` lines, last one per id wins. */
function sessionIndexFile(): string {
  return path.join(codexHome(), "session_index.jsonl");
}

const TITLE_MAX_LENGTH = 60;
/** Same budget as Claude's scan for the same reason: bounds a pathological single line. */
const TAIL_SCAN_BYTE_LIMIT = 256 * 1024;
/**
 * A rollout's `session_meta` line is always first, but not small: since 0.14x it carries the whole
 * base instructions (~22 KB measured), and an 8 KB budget cut every one of them short — no Codex
 * session was ever listed. Only the first line is read either way; this bounds a pathological one.
 */
const META_SCAN_BYTE_LIMIT = TAIL_SCAN_BYTE_LIMIT;

interface SessionMeta {
  sessionId: string;
  cwd: string;
  source: string;
  /** The line's own timestamp — a far more stable "created" signal than mtime. */
  createdAt?: number;
}

/**
 * Cached by path once read: `session_meta` never changes, and a listing runs for every rollout
 * on the machine on every change to any of them. A failed read is not cached — a rollout that
 * has only just been created can still be empty the first time it is seen.
 */
const metaCache = new Map<string, SessionMeta>();

/** Reads only the first line of a rollout — `session_meta` is always written there, never later. */
async function readSessionMeta(filePath: string): Promise<SessionMeta | undefined> {
  const cached = metaCache.get(filePath);
  if (cached) {
    return cached;
  }
  const meta = await parseSessionMeta(filePath);
  if (meta) {
    metaCache.set(filePath, meta);
  }
  return meta;
}

async function parseSessionMeta(filePath: string): Promise<SessionMeta | undefined> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: META_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
      if (entry.type !== "session_meta") {
        return undefined;
      }
      const payload = entry.payload as Record<string, unknown> | undefined;
      const sessionId = nonEmptyString(payload?.session_id);
      const cwd = nonEmptyString(payload?.cwd);
      const source = nonEmptyString(payload?.source);
      if (!sessionId || !cwd) {
        return undefined;
      }
      const createdAt = Date.parse(nonEmptyString(entry.timestamp) ?? "");
      return { sessionId, cwd, source: source ?? "", createdAt: Number.isNaN(createdAt) ? undefined : createdAt };
    }
  } catch (error) {
    console.error("[tet] codex session_meta read failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  return undefined;
}

/**
 * What a listing needs from a rollout's body: the first real prompt from its head, and,
 * backwards from the end, the last turn boundary — `task_complete`/`turn_aborted` cover a normal
 * end and an interrupted one alike, the net under the Stop hook the
 * same way Claude's `turn_duration` is. Cached by path and size for the same reason Claude's
 * scan is: a listing runs for every session on every change to any of them.
 */
interface TailInfo {
  turnEndedAt?: number;
  /** The first real user prompt — Codex assigns no title of its own, so this stands in for one. */
  firstPrompt?: string;
}

const tailCache = new Map<string, { size: number; tail: TailInfo }>();

const TURN_END_TYPES = ['"task_complete"', '"turn_aborted"'];
const PROMPT_TYPES = ['"user_message"', '"role":"user"'];

/** The last turn boundary in `lines`, if any — read backwards, since only the last one counts. */
function readTurnEnd(lines: string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!TURN_END_TYPES.some((type) => line.includes(type))) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (payload?.type === "task_complete" || payload?.type === "turn_aborted") {
      const ms = Date.parse(nonEmptyString(entry.timestamp) ?? "");
      if (!Number.isNaN(ms)) {
        return ms;
      }
    }
  }
  return undefined;
}

/**
 * The first real prompt, read forwards from the head: Codex writes its injected context blocks
 * first, so it sits a few lines in — never in the tail, which is why it is not looked for there
 * (the tail is read newest chunk first, and its first prompt would be a later one's).
 */
async function readFirstPrompt(handle: fs.promises.FileHandle, size: number): Promise<string | undefined> {
  const buffer = Buffer.alloc(Math.min(size, TAIL_SCAN_BYTE_LIMIT));
  await handle.read(buffer, 0, buffer.length, 0);
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!PROMPT_TYPES.some((type) => line.includes(type))) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const prompt = extractUserPrompt(entry);
    if (prompt !== undefined) {
      return truncateTitle(prompt);
    }
  }
  return undefined;
}

/** A real typed prompt, not the `<environment_context>`/`<skills_instructions>` blocks Codex injects. */
function extractUserPrompt(entry: Record<string, unknown>): string | undefined {
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (entry.type === "event_msg" && payload?.type === "user_message") {
    return nonEmptyString(payload.message);
  }
  if (entry.type === "response_item" && payload?.role === "user") {
    const content = payload.content as { type?: unknown; text?: unknown }[] | undefined;
    const text = content?.find((part) => part.type === "input_text" && typeof part.text === "string")?.text as
      | string
      | undefined;
    if (text && !text.startsWith("<")) {
      return text;
    }
  }
  return undefined;
}

async function scanTail(filePath: string): Promise<TailInfo> {
  const tail: TailInfo = {};
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const { size } = await handle.stat();
    const cached = tailCache.get(filePath);
    if (cached?.size === size) {
      return cached.tail;
    }
    // The first prompt never changes once written, so a session that has already been scanned
    // once keeps that answer regardless of how much has grown; only one that had none yet
    // (just created, nothing typed) looks again.
    tail.firstPrompt = cached?.tail.firstPrompt ?? (await readFirstPrompt(handle, size));
    const previous = cached && cached.size < size ? cached : undefined;
    const floor = previous ? Math.max(0, previous.size - TAIL_SCAN_BYTE_LIMIT) : 0;
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > floor && tail.turnEndedAt === undefined) {
      const start = Math.max(floor, end - TAIL_SCAN_BYTE_LIMIT);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      let chunk = Buffer.concat([buffer, carry]);
      if (start > floor) {
        const cut = chunk.indexOf(10);
        carry = cut === -1 ? chunk : chunk.subarray(0, cut);
        chunk = cut === -1 ? Buffer.alloc(0) : chunk.subarray(cut + 1);
      }
      tail.turnEndedAt = readTurnEnd(chunk.toString("utf8").split("\n"));
      end = start;
    }
    tail.turnEndedAt ??= previous?.tail.turnEndedAt;
    tailCache.set(filePath, { size, tail });
  } catch (error) {
    console.error("[tet] codex rollout scan failed:", error);
  } finally {
    await handle?.close();
  }
  return tail;
}

/** `{id -> name}`, the last `session_index.jsonl` line per id — small file, read whole each time. */
async function readSessionNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let text: string;
  try {
    text = await fs.promises.readFile(sessionIndexFile(), "utf8");
  } catch {
    return names;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      const id = nonEmptyString(entry.id);
      const name = nonEmptyString(entry.thread_name);
      if (id) {
        // Last entry wins — a rename appends rather than replacing, an unset name is still an
        // entry (Codex writes one on every name change including clearing it back to none).
        if (name) {
          names.set(id, name);
        } else {
          names.delete(id);
        }
      }
    } catch {
      continue;
    }
  }
  return names;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > TITLE_MAX_LENGTH ? `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…` : normalized;
}

/** Every `.jsonl` rollout under `sessions/`, three levels deep (`YYYY/MM/DD`). */
async function listRolloutFiles(): Promise<string[]> {
  const files: string[] = [];
  const root = sessionsRoot();
  for (const year of await safeReaddir(root)) {
    for (const month of await safeReaddir(path.join(root, year))) {
      for (const day of await safeReaddir(path.join(root, year, month))) {
        const dayDir = path.join(root, year, month, day);
        for (const name of await safeReaddir(dayDir)) {
          if (name.endsWith(".jsonl")) {
            files.push(path.join(dayDir, name));
          }
        }
      }
    }
  }
  return files;
}

/**
 * How many rollouts are read at once. Every rollout on the machine — all projects, every `exec`
 * run — is opened by a listing, and all of them at once is more file descriptors than a low
 * `ulimit -n` allows once there are a thousand.
 */
const READ_CONCURRENCY = 32;

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    })
  );
  return results;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Both caches hold an entry per rollout on the machine and are keyed by path, so a rollout
 * deleted — by `remove`, or by Codex's own picker behind tet's back — is dropped here, at the
 * one point every listing already knows the full set. Without this they only ever grow.
 */
function forgetMissing(files: string[]): void {
  const present = new Set(files);
  for (const cache of [metaCache, tailCache]) {
    for (const filePath of cache.keys()) {
      if (!present.has(filePath)) {
        cache.delete(filePath);
      }
    }
  }
}

/** win32 paths are case-insensitive; Codex itself lower-cases them for its own `cwd` matching. */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const codexSessionProvider: SessionProvider = {
  async list(_executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    try {
      const files = await listRolloutFiles();
      forgetMissing(files);
      const names = await readSessionNames();
      const entries = await mapLimited(files, async (filePath): Promise<AgentSessionInfo | undefined> => {
          const meta = await readSessionMeta(filePath);
          // `exec`/`mcp`/subagent runs are never interactive sessions of this repository's
          // tabs — only `cli` is, matching what Codex's own `/resume` picker shows by default.
          if (!meta || meta.source !== "cli" || !samePath(meta.cwd, cwd)) {
            return undefined;
          }
          const [tail, stat] = await Promise.all([scanTail(filePath), fs.promises.stat(filePath)]);
          const title = names.get(meta.sessionId) ?? tail.firstPrompt ?? "";
          return {
            id: meta.sessionId,
            title,
            updatedAt: stat.mtimeMs,
            createdAt: meta.createdAt ?? stat.mtimeMs,
            turnEndedAt: tail.turnEndedAt
          };
        });
      const sessions = entries.filter((entry): entry is AgentSessionInfo => entry !== undefined);
      sessions.sort((a, b) => a.createdAt - b.createdAt);
      return sessions;
    } catch (error) {
      console.error("[tet] codex session listing failed:", error);
      return [];
    }
  },

  resumeArgs(sessionId: string): string[] {
    return ["resume", sessionId];
  },

  async remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    await deleteThread(executable, cwd, sessionId);
  },

  /**
   * The only writer of a Codex thread's name is the app-server RPC Codex's own `/rename` uses
   * internally — there is no CLI command and no rollout entry the picker reads as a name.
   */
  async rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title must be non-empty");
    }
    await renameThread(executable, cwd, sessionId, trimmed);
  },

  /**
   * Watches today's rollout folder for new/changed sessions and the name index for renames.
   * Two-stage like Claude's: the day's folder (and the month's, and the year's) may not exist
   * yet, and `fs.watch` throws on a missing directory. Not scoped to `cwd` — there is no
   * per-repository folder to watch, unlike Claude's — `list()` filters by cwd on every read.
   */
  watch(_executable: string, _cwd: string, onChange: () => void): () => void {
    let stopped = false;
    const watchers: fs.FSWatcher[] = [];
    const armed = new Set<string>();

    const closeAll = (): void => {
      for (const watcher of watchers) {
        watcher.close();
      }
      watchers.length = 0;
      armed.clear();
    };

    const arm = (dir: string, onEvent: (filename: string | null) => void): void => {
      if (stopped || armed.has(dir)) {
        return;
      }
      try {
        const watcher = fs.watch(dir, (_type, filename) => onEvent(filename));
        watchers.push(watcher);
        armed.add(dir);
      } catch {
        // Doesn't exist yet — the parent's own watch below re-checks once it's created.
      }
    };

    // A day changes at most once every 24h; re-resolving the chain on every poll is cheap and
    // keeps this correct across midnight without a timer of its own.
    const rearm = (): void => {
      if (stopped) {
        return;
      }
      closeAll();
      const root = sessionsRoot();
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      const dayDir = path.join(root, year, month, day);
      arm(root, () => rearm());
      arm(path.join(root, year), () => rearm());
      arm(path.join(root, year, month), () => rearm());
      arm(dayDir, (filename) => {
        if (filename === null || filename.endsWith(".jsonl")) {
          onChange();
        }
      });
      arm(codexHome(), (filename) => {
        if (filename === "session_index.jsonl") {
          onChange();
        }
      });
    };
    rearm();

    return () => {
      stopped = true;
      closeAll();
    };
  }
};
