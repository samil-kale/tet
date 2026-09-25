import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import {
  collectSessions,
  forgetMissing,
  nonEmptyString,
  parseLine,
  readHeadLines,
  requireTitle,
  scanTranscriptHead,
  scanTranscriptTail,
  timestampOf,
  TRANSCRIPT_SCAN_BYTES,
  truncateTitle,
  type ScannedTail
} from "../transcript";
import { renameThread } from "./app-server-client";
import { runCodex } from "./cli";
import { SANDBOX_HOME } from "../../terminals/hook-target";
import { mapLimited } from "../../map-limited";

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
  let meta: SessionMeta | undefined;
  await readHeadLines(filePath, TRANSCRIPT_SCAN_BYTES, "codex", (line) => {
    const entry = parseLine(line);
    const payload = entry?.type === "session_meta" ? (entry.payload as Record<string, unknown> | undefined) : undefined;
    const sessionId = nonEmptyString(payload?.session_id);
    const cwd = nonEmptyString(payload?.cwd);
    if (entry && sessionId && cwd) {
      meta = { sessionId, cwd, source: nonEmptyString(payload?.source) ?? "", createdAt: timestampOf(entry.timestamp) };
    }
    // Only ever the first line: a rollout that does not open with a usable `session_meta` is none.
    return true;
  });
  return meta;
}

/**
 * A listing's needs from a rollout body's end: the last turn end — `task_complete` or
 * `turn_aborted` (interrupted), the net under the Stop hook. Cached by path and size.
 */
interface TailInfo {
  turnEndedAt?: number;
}

const tailCache = new Map<string, { size: number; tail: TailInfo }>();

/** And from its head: the first prompt, which stands in for a title (Codex assigns none). Keyed by
 *  how much of the window the file fills, like the other agents' head caches. */
interface HeadInfo {
  firstPrompt?: string;
}

const headCache = new Map<string, { size: number; head: HeadInfo }>();

const TURN_END_TYPES = ['"task_complete"', '"turn_aborted"'];
const PROMPT_TYPES = ['"user_message"', '"role":"user"'];

/** The last turn boundary in `lines`, if any. */
function readTurnEnd(lines: string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!TURN_END_TYPES.some((type) => line.includes(type))) {
      continue;
    }
    const entry = parseLine(line);
    if (!entry) {
      continue;
    }
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (payload?.type === "task_complete" || payload?.type === "turn_aborted") {
      const ms = timestampOf(entry.timestamp);
      if (ms !== undefined) {
        return ms;
      }
    }
  }
  return undefined;
}

/** The first real prompt, read forwards: it follows Codex's injected context blocks. */
function scanHead(filePath: string, fileSize: number): Promise<HeadInfo> {
  return scanTranscriptHead(filePath, fileSize, headCache, {
    label: "codex",
    create: (): HeadInfo => ({}),
    read: (line, head) => {
      if (!PROMPT_TYPES.some((type) => line.includes(type))) {
        return false;
      }
      const entry = parseLine(line);
      const prompt = entry ? extractUserPrompt(entry) : undefined;
      if (prompt === undefined) {
        return false;
      }
      head.firstPrompt = truncateTitle(prompt);
      return true;
    }
  });
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

function scanTail(filePath: string): Promise<ScannedTail<TailInfo>> {
  return scanTranscriptTail(filePath, tailCache, {
    byteLimit: TRANSCRIPT_SCAN_BYTES,
    label: "codex",
    create: (): TailInfo => ({}),
    read: (lines, tail) => {
      tail.turnEndedAt = readTurnEnd(lines);
      return tail.turnEndedAt !== undefined;
    },
    merge: (tail, previous) => {
      tail.turnEndedAt ??= previous.turnEndedAt;
    }
  });
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
    const entry = parseLine(line);
    const id = nonEmptyString(entry?.id);
    if (id) {
      // Last entry wins: renames append, and clearing a name appends an entry without one.
      const name = nonEmptyString(entry?.thread_name);
      if (name) {
        names.set(id, name);
      } else {
        names.delete(id);
      }
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

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

/** win32 paths are case-insensitive; Codex lower-cases them for its own `cwd` matching. */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const codexSessionProvider: SessionProvider = {
  list(cwd: string): Promise<AgentSessionInfo[]> {
    return listIn(codexHome(), cwd);
  },

  resumeArgs(sessionId: string): string[] {
    return ["resume", sessionId];
  },

  /** `codex delete` drops the rollout, the index lines and the db rows, as `thread/delete` does;
   *  `--force` asks nothing, taking only a UUID (measured, 0.156.1). A failure for a thread
   *  without a rollout resolves (SessionProvider.remove): an unknown id exits 1 with the generic
   *  "failed to delete session", so the rollout files say whether it is gone, not the answer. */
  async remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    try {
      await runCodex(executable, cwd, ["delete", "--force", sessionId]);
    } catch (error) {
      if ((await rolloutFilesOf(codexHome(), sessionId)).length > 0) {
        throw error;
      }
    }
  },

  rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    return renameIn(executable, cwd, sessionId, title);
  },

  /**
   * The sandbox's `~/.codex/sessions` plus `session_index.jsonl`, where names live outside the
   * rollout. Measured: the codex template has no volume under `~/.codex`, sbx creates a missing
   * target of either kind, and `auth.json` stays unmounted. Rename and delete edit the mounted
   * files (removeInHome, renameInHome): a host `codex` needs Codex on the host and leaves a whole
   * Codex home of its own in the root.
   */
  sandbox: {
    mounts: [
      { sub: "sessions", target: `${SANDBOX_HOME}/.codex/sessions` },
      { sub: "session_index.jsonl", target: `${SANDBOX_HOME}/.codex/session_index.jsonl`, file: true }
    ],
    list: (root, cwd) => listIn(root, cwd),
    remove: (root, _cwd, sessionId) => removeInHome(root, sessionId),
    rename: (root, _cwd, sessionId, title) => renameInHome(root, sessionId, title)
  },

  /**
   * Watches today's rollout folder and the name index. Its ancestors are watched too, since the
   * day's folder may not exist yet and `fs.watch` throws on one. Not per repository: `list()`
   * filters by cwd.
   */
  watch(_cwd: string, onChange: () => void): () => void {
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

function listIn(home: string, cwd: string): Promise<AgentSessionInfo[]> {
  return collectSessions("codex", async () => {
    const files = await listRolloutFiles(home);
    forgetMissing(sessionsRoot(home), files, [metaCache, tailCache, headCache]);
    const names = await readSessionNames(home);
    return mapLimited(files, READ_CONCURRENCY, async (filePath): Promise<AgentSessionInfo | undefined> => {
      const meta = await readSessionMeta(filePath);
      // Only `source: "cli"` is interactive, as in Codex's `/resume` picker.
      if (!meta || meta.source !== "cli" || !samePath(meta.cwd, cwd)) {
        return undefined;
      }
      const { tail, size, mtimeMs } = await scanTail(filePath);
      const title = names.get(meta.sessionId) ?? (await scanHead(filePath, size)).firstPrompt ?? "";
      return {
        id: meta.sessionId,
        title,
        updatedAt: mtimeMs,
        createdAt: meta.createdAt ?? mtimeMs,
        turnEndedAt: tail.turnEndedAt
      };
    });
  });
}

/** Only the app-server RPC writes a thread's name — no CLI command, no rollout entry. */
async function renameIn(executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
  await renameThread(executable, cwd, sessionId, requireTitle(title));
}

/**
 * `codex delete` on the files alone: the rollout goes; an unknown id resolves
 * (SessionProvider.remove). Codex inside the sandbox (0.149.1) then hides the thread from its lists
 * and resume picker, and `codex resume <id or name>` answers "No saved session found", though its
 * own db keeps a row.
 *
 * The host's `codex delete` (0.156.1) also drops the id's index lines; this leaves them. Measured
 * harmless: Codex inside behaves the same with or without them, and listIn names only rollouts it
 * finds. Rewriting the index is not: while Codex inside appends to it through the Windows mount
 * (sbx 0.42.1), the replacing rename failed with EPERM for 1 in 8, about one appended line was
 * lost per rewrite, and some appends landed as NUL runs.
 */
async function removeInHome(home: string, sessionId: string): Promise<void> {
  for (const filePath of await rolloutFilesOf(home, sessionId)) {
    await fs.promises.rm(filePath, { force: true });
    metaCache.delete(filePath);
    tailCache.delete(filePath);
    headCache.delete(filePath);
  }
}

/** The rollouts holding one session. */
async function rolloutFilesOf(home: string, sessionId: string): Promise<string[]> {
  const files = await listRolloutFiles(home);
  const metas = await mapLimited(files, READ_CONCURRENCY, readSessionMeta);
  return files.filter((_, i) => metas[i]?.sessionId === sessionId);
}

/**
 * `thread/name/set` on the files alone (measured against host 0.154.0 and 0.149.1 in the sandbox):
 * one appended index line, `updated_at` with seven fractional digits on both. Codex inside the
 * sandbox reads names from its own db only, so it keeps showing the old name.
 */
async function renameInHome(home: string, sessionId: string, title: string): Promise<void> {
  const trimmed = requireTitle(title);
  const entry = { id: sessionId, thread_name: trimmed, updated_at: new Date().toISOString().replace("Z", "0000Z") };
  await fs.promises.appendFile(sessionIndexFile(home), JSON.stringify(entry) + "\n");
}
