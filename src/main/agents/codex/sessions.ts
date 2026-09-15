import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { nonEmptyString, readLinesBackwards, truncateTitle } from "../transcript";
import { deleteThread, renameThread } from "./app-server-client";
import { SANDBOX_HOME } from "../../terminals/hook-target";

/** Codex's config root; tet never overrides it. */
function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function sessionsRoot(home: string): string {
  return path.join(home, "sessions");
}

/** Codex's name index — `{id, thread_name, updated_at}` lines, the last per id wins. */
function sessionIndexFile(home: string): string {
  return path.join(home, "session_index.jsonl");
}

/** Bounds a pathological single line, as Claude's scan does. */
const TAIL_SCAN_BYTE_LIMIT = 256 * 1024;
/** `session_meta` is first but not small: it carries the whole base instructions (measured,
 *  0.14x), and a smaller budget cuts it short so no session lists. */
const META_SCAN_BYTE_LIMIT = TAIL_SCAN_BYTE_LIMIT;

interface SessionMeta {
  sessionId: string;
  cwd: string;
  source: string;
  /** The line's own timestamp — steadier than mtime. */
  createdAt?: number;
}

/**
 * `session_meta` never changes, and a listing reads every rollout on the machine. Failed reads are
 * not cached — a just-created rollout can still be empty.
 */
const metaCache = new Map<string, SessionMeta>();

/** `session_meta` is always a rollout's first line. */
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
 * A listing's needs from a rollout body: the first prompt from its head, and the last turn end —
 * `task_complete` or `turn_aborted` (interrupted), the net under the Stop hook. Cached by path and size.
 */
interface TailInfo {
  turnEndedAt?: number;
  /** Stands in for a title; Codex assigns none. */
  firstPrompt?: string;
}

const tailCache = new Map<string, { size: number; tail: TailInfo }>();

const TURN_END_TYPES = ['"task_complete"', '"turn_aborted"'];
const PROMPT_TYPES = ['"user_message"', '"role":"user"'];

/** The last turn boundary in `lines`, if any. */
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

/** The first real prompt, read forwards: it follows Codex's injected context blocks. */
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

/** A typed prompt, not an injected `<environment_context>`/`<skills_instructions>` block. */
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
    // A written first prompt never changes; only a session without one looks again.
    tail.firstPrompt = cached?.tail.firstPrompt ?? (await readFirstPrompt(handle, size));
    const previous = cached && cached.size < size ? cached : undefined;
    const floor = previous ? Math.max(0, previous.size - TAIL_SCAN_BYTE_LIMIT) : 0;
    await readLinesBackwards(handle, size, floor, TAIL_SCAN_BYTE_LIMIT, (lines) => {
      tail.turnEndedAt = readTurnEnd(lines);
      return tail.turnEndedAt !== undefined;
    });
    tail.turnEndedAt ??= previous?.tail.turnEndedAt;
    tailCache.set(filePath, { size, tail });
  } catch (error) {
    console.error("[tet] codex rollout scan failed:", error);
  } finally {
    await handle?.close();
  }
  return tail;
}

/** `{id -> name}` from `session_index.jsonl` — small, read whole each time. */
async function readSessionNames(home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let text: string;
  try {
    text = await fs.promises.readFile(sessionIndexFile(home), "utf8");
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
        // Last entry wins: renames append, and clearing a name appends an entry without one.
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

/** Every `.jsonl` rollout under `sessions/`, three levels deep (`YYYY/MM/DD`). */
async function listRolloutFiles(home: string): Promise<string[]> {
  const files: string[] = [];
  const root = sessionsRoot(home);
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

/** Rollouts read at once: a listing opens every rollout on the machine, and all at once exceeds a
 *  low `ulimit -n`. */
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
 * Evicts cached rollouts that are gone (Codex's picker deletes them behind tet's back). Scoped to
 * `root`: a sandbox root (SessionProvider.sandbox) shares these caches, and the two would evict
 * each other's entries.
 */
function forgetMissing(files: string[], root: string): void {
  const present = new Set(files);
  const prefix = root + path.sep;
  for (const cache of [metaCache, tailCache]) {
    for (const filePath of cache.keys()) {
      if (filePath.startsWith(prefix) && !present.has(filePath)) {
        cache.delete(filePath);
      }
    }
  }
}

/** win32 paths are case-insensitive; Codex lower-cases them for its own `cwd` matching. */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const codexSessionProvider: SessionProvider = {
  list(_executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    return listIn(codexHome(), cwd);
  },

  resumeArgs(sessionId: string): string[] {
    return ["resume", sessionId];
  },

  remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    return deleteThread(executable, cwd, sessionId);
  },

  rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    return renameIn(executable, cwd, sessionId, title);
  },

  /**
   * The sandbox's `~/.codex/sessions` plus `session_index.jsonl`, where names live outside the
   * rollout. Measured: the codex template has no volume under `~/.codex`, sbx creates a missing
   * target of either kind, and `auth.json` stays unmounted. The root is shaped like a `CODEX_HOME`,
   * so rename and delete run against it (`deleteThread`).
   */
  sandbox: {
    mounts: [
      { sub: "sessions", target: `${SANDBOX_HOME}/.codex/sessions` },
      { sub: "session_index.jsonl", target: `${SANDBOX_HOME}/.codex/session_index.jsonl`, file: true }
    ],
    list: (_executable, root, cwd) => listIn(root, cwd),
    // The root as cwd too: the sandbox's cwd is a container path, and spawning there fails with
    // ENOENT. Threads are addressed by id under CODEX_HOME anyway.
    remove: (executable, root, _cwd, sessionId) => deleteThread(executable, root, sessionId, root),
    rename: (executable, root, _cwd, sessionId, title) => renameIn(executable, root, sessionId, title, root)
  },

  /**
   * Watches today's rollout folder and the name index. Its ancestors are watched too, since the
   * day's folder may not exist yet and `fs.watch` throws on one. Not per repository: `list()`
   * filters by cwd.
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
        // Doesn't exist yet — the parent's watch re-arms once it does.
      }
    };

    // Re-resolved on every event, so midnight needs no timer.
    const rearm = (): void => {
      if (stopped) {
        return;
      }
      closeAll();
      const root = sessionsRoot(codexHome());
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

async function listIn(home: string, cwd: string): Promise<AgentSessionInfo[]> {
  try {
    const files = await listRolloutFiles(home);
    forgetMissing(files, sessionsRoot(home));
    const names = await readSessionNames(home);
    const entries = await mapLimited(files, async (filePath): Promise<AgentSessionInfo | undefined> => {
      const meta = await readSessionMeta(filePath);
      // Only `source: "cli"` is interactive, as in Codex's `/resume` picker.
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
}

/** Only the app-server RPC writes a thread's name — no CLI command, no rollout entry. */
async function renameIn(executable: string, cwd: string, sessionId: string, title: string, home?: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("title must be non-empty");
  }
  await renameThread(executable, cwd, sessionId, trimmed, home);
}
