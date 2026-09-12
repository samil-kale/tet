import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { findEncodedDir, nonEmptyString, scanTranscriptTail, truncateTitle } from "../transcript";
import { watchTranscriptDir } from "../../watch-dir";
import { SANDBOX_HOME } from "../../terminals/hook-target";

/**
 * pi keeps one JSONL transcript per session under its own config directory, named
 * `<ISO timestamp with ":" and "." as "-">_<uuid>.jsonl` inside a directory encoding the working
 * directory — see encodeCwd. The format below was read off the real files pi 0.85.1 wrote:
 *
 * - line 1 is the header `{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>",
 *   "cwd":"<path>"}`; the session's id is the header's, which is what `--session` matches
 * - every later line is an entry with an 8-hex `id`, a `parentId` (a tree: pi branches in place)
 *   and an ISO `timestamp`; `message` entries carry `message.role` and, for the assistant,
 *   `stopReason` — an Escape-abort is persisted as `"aborted"`
 * - the file is created only with the first assistant message; until then the id exists in pi's
 *   memory alone — which costs nothing, since a turn is reported for the tab, not the session
 * - the display name is the LAST `session_info` entry in file order, whatever its tree position,
 *   a blank one being an explicit clear; without one pi shows the first user message
 */
export const piSessionProvider: SessionProvider = {
  list(_executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    return listIn(sessionsRoot(), cwd);
  },

  resumeArgs(sessionId: string): string[] {
    return ["--session", sessionId];
  },

  remove(_executable: string, cwd: string, sessionId: string): Promise<void> {
    return removeIn(sessionsRoot(), cwd, sessionId);
  },

  rename(_executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    return renameIn(sessionsRoot(), cwd, sessionId, title);
  },

  /** The session directory exists only once pi has written a transcript here — see watchTranscriptDir. */
  watch(_executable: string, cwd: string, onChange: () => void): () => void {
    return watchTranscriptDir(
      sessionsRoot,
      () => findSessionDir(sessionsRoot(), cwd),
      (filename) => filename.endsWith(".jsonl"),
      onChange
    );
  },

  /**
   * `~/.pi/agent/sessions` inside the sandbox — the default path, since `PI_CODING_AGENT_DIR` is
   * never set for a sandboxed tab either. Measured: nothing else of pi's config directory is a
   * mount or a volume there, and `auth.json` sits beside this directory rather than in it, so
   * mounting it carries no identity out of the sandbox.
   */
  sandbox: {
    mounts: [{ sub: "sessions", target: `${SANDBOX_HOME}/.pi/agent/sessions` }],
    list: (_executable, root, cwd) => listIn(path.join(root, "sessions"), cwd),
    remove: (_executable, root, cwd, sessionId) => removeIn(path.join(root, "sessions"), cwd, sessionId),
    rename: (_executable, root, cwd, sessionId, title) => renameIn(path.join(root, "sessions"), cwd, sessionId, title)
  }
};

async function listIn(root: string, cwd: string): Promise<AgentSessionInfo[]> {
  try {
    const dir = await findSessionDir(root, cwd);
    if (!dir) {
      return [];
    }
    const files = (await fs.promises.readdir(dir)).filter((file) => file.endsWith(".jsonl"));
    forgetMissing(dir, files);
    const entries = await Promise.all(
      files.map(async (file): Promise<AgentSessionInfo | undefined> => {
        const filePath = path.join(dir, file);
        const stat = await fs.promises.stat(filePath);
        const head = await scanHead(filePath, stat.size);
        if (!head) {
          return undefined;
        }
        const tail = await scanTail(filePath);
        return {
          id: head.id,
          title: tail.name ? truncateTitle(tail.name) : (head.firstPrompt ?? ""),
          // mtime: only ever compared for change, and a rename bumps it too.
          updatedAt: stat.mtimeMs,
          createdAt: head.createdAt ?? stat.mtimeMs,
          turnEndedAt: tail.turnEndedAt
          // No provisionalTitle: pi never names a session, so a title from the first prompt is
          // final — flagging it would keep reconcile polling for a name that never comes.
        };
      })
    );
    const sessions = entries.filter((entry): entry is AgentSessionInfo => entry !== undefined);
    sessions.sort((a, b) => a.createdAt - b.createdAt);
    return sessions;
  } catch (error) {
    console.error("[tet] pi session listing failed:", error);
    return [];
  }
}

/** No session directory and no transcript both mean the session is already gone — resolved, not
 *  rejected, per SessionProvider.remove. A transcript can disappear behind tet's back, and the
 *  tab still holding its id was then unclosable. */
async function removeIn(root: string, cwd: string, sessionId: string): Promise<void> {
  const dir = await findSessionDir(root, cwd);
  if (!dir) {
    return;
  }
  const filePath = await findSessionFile(dir, sessionId);
  if (!filePath) {
    return;
  }
  // Nothing beside the transcript: pi keeps no per-session directory.
  await fs.promises.rm(filePath, { force: true });
  headCache.delete(filePath);
  scanCache.delete(filePath);
}

/**
 * Mirrors pi's own `/name` (appendSessionInfo): a `session_info` entry appended to the transcript,
 * parented to whatever entry is last. Measured to work while pi is running on the file — it keeps
 * appending with its own in-memory leaf as parent, the file stays valid, and the running pi shows
 * the new name only after a restart, reading the file once at startup.
 */
async function renameIn(root: string, cwd: string, sessionId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("title must be non-empty");
  }
  const dir = await findSessionDir(root, cwd);
  if (!dir) {
    throw new Error("pi session directory not found");
  }
  const filePath = await findSessionFile(dir, sessionId);
  if (!filePath) {
    throw new Error("pi session not found");
  }
  // The whole file, not just its tail: the new entry's id has to be unique across all of it (pi
  // keys its tree by id), and a rename is a rare, user-initiated action.
  const text = await fs.promises.readFile(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  let last: Record<string, unknown>;
  try {
    last = JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
  } catch {
    throw new Error("pi transcript is not readable");
  }
  // The header is the only line without an entry id; an entry right after it is a root
  // (parentId null), which is how pi writes its own first entry.
  const parentId = last.type === "session" ? null : (nonEmptyString(last.id) ?? null);
  let id: string;
  do {
    id = crypto.randomUUID().slice(0, 8);
  } while (text.includes(`"id":"${id}"`));
  const entry = { type: "session_info", id, parentId, timestamp: new Date().toISOString(), name: trimmed };
  await fs.promises.appendFile(filePath, (text.endsWith("\n") ? "" : "\n") + JSON.stringify(entry) + "\n");
  scanCache.delete(filePath);
}

/**
 * pi's config directory — the one env override it documents, and what the tests set. Its other
 * two ways of moving sessions, `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` key of its
 * settings.json, are not honoured: the second would mean reading the user's configuration.
 */
function sessionsRoot(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

/**
 * pi's own encoding of a working directory (getDefaultSessionDirPath): the resolved path with a
 * leading `/` or `\` dropped and every `/`, `\` and `:` turned into `-`, wrapped in `--`. So
 * `C:\Users\x\repo` becomes `--C--Users-x-repo--`.
 */
export function encodeCwd(cwd: string): string {
  return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Where this repository's transcripts are, or undefined where pi has never run in it. Measured on
 * win32: the drive letter's case follows whatever pi was spawned with (`c:\…` gives `--c--Users…`)
 * while the folder names come back canonical — findEncodedDir's case-insensitive match covers it.
 */
function findSessionDir(root: string, cwd: string): Promise<string | undefined> {
  return findEncodedDir(root, encodeCwd(cwd));
}

/** The transcript holding a session, by the uuid in its filename — or, for a file pi renamed or
 *  forked into place, by the header's id. */
/** Undefined when no transcript carries this id — a removal takes that for "already gone". */
async function findSessionFile(dir: string, sessionId: string): Promise<string | undefined> {
  const files = (await fs.promises.readdir(dir)).filter((file) => file.endsWith(".jsonl"));
  const named = files.find((file) => file.endsWith(`_${sessionId}.jsonl`));
  if (named) {
    return path.join(dir, named);
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    const head = await scanHead(filePath, (await fs.promises.stat(filePath)).size);
    if (head?.id === sessionId) {
      return filePath;
    }
  }
  return undefined;
}

/** Drops the caches of transcripts that are gone — a session deleted by pi itself. */
function forgetMissing(dir: string, files: string[]): void {
  const present = new Set(files.map((file) => path.join(dir, file)));
  for (const cache of [headCache, scanCache]) {
    for (const filePath of cache.keys()) {
      if (path.dirname(filePath) === dir && !present.has(filePath)) {
        cache.delete(filePath);
      }
    }
  }
}

interface TranscriptHead {
  /** The header's id — the session's, and what `--session` matches against. */
  id: string;
  /** The header's timestamp, ms. pi writes it at startup, so it is always after the tab's spawn. */
  createdAt?: number;
  /** The first user message, truncated on the way in — pi's own picker shows the same. */
  firstPrompt?: string;
}

/** The transcript's start is all the head needs; pi's own picker reads the whole file. */
const HEAD_SCAN_BYTE_LIMIT = 256 * 1024;

/** Keyed by how much of the window the file fills rather than by its size: the stream only ever
 *  reads the first HEAD_SCAN_BYTE_LIMIT bytes of an append-only file. */
const headCache = new Map<string, { size: number; head: TranscriptHead }>();

/** The header and the first prompt; undefined for a `.jsonl` that is not a pi transcript. */
async function scanHead(filePath: string, fileSize: number): Promise<TranscriptHead | undefined> {
  const size = Math.min(fileSize, HEAD_SCAN_BYTE_LIMIT);
  const cached = headCache.get(filePath);
  if (cached?.size === size) {
    return cached.head;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: HEAD_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let head: TranscriptHead | undefined;
  try {
    for await (const line of lines) {
      if (!head) {
        // pi's own listing skips a file whose first line is not a header, and so does this.
        const header = parseLine(line);
        const id = header?.type === "session" ? nonEmptyString(header.id) : undefined;
        if (id === undefined) {
          return undefined;
        }
        const createdAt = Date.parse(nonEmptyString(header?.timestamp) ?? "");
        head = { id, createdAt: Number.isNaN(createdAt) ? undefined : createdAt };
        continue;
      }
      // Only the first user message is wanted; every other line is skipped unparsed.
      if (!line.includes('"user"')) {
        continue;
      }
      const entry = parseLine(line);
      const message = entry?.type === "message" ? (entry.message as Record<string, unknown> | undefined) : undefined;
      if (message?.role === "user") {
        const prompt = messageText(message.content);
        head.firstPrompt = prompt === undefined ? undefined : truncateTitle(prompt);
        break;
      }
    }
    // A file with a header but no prompt yet can still grow into one, unless the window is
    // already full — then what it holds is all this scan will ever see.
    if (head && (head.firstPrompt !== undefined || size >= HEAD_SCAN_BYTE_LIMIT)) {
      headCache.set(filePath, { size, head });
    }
  } catch (error) {
    console.error("[tet] pi title extraction failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  return head;
}

/** A message's text: a plain string, or its `text` blocks joined — the way pi's picker reads it. */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return nonEmptyString(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? (block as { text?: unknown }).text : undefined))
    .filter((text): text is string => typeof text === "string" && text.trim() !== "");
  return texts.length > 0 ? texts.join(" ") : undefined;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

interface TranscriptTail {
  /** The last session_info's name, trimmed — "" for one that clears the name (pi reads
   *  `entry.name?.trim() || undefined`, and the last one wins whatever its tree position). */
  name?: string;
  /** When the last assistant message was written, whichever way its turn ended — an Escape-abort
   *  is persisted as one with `stopReason: "aborted"` too. Its own ms timestamp first, the entry's
   *  ISO one as fallback, the way pi's getMessageActivityTime reads it. */
  turnEndedAt?: number;
}

const TAIL_SCAN_BYTE_LIMIT = 256 * 1024;

/** Only a line naming one of these is worth parsing — most of a transcript is tool output. */
const TAIL_ENTRY_TYPES = ['"session_info"', '"assistant"'];

/**
 * The last scan of each transcript, by path: all but the one being written to are answered from
 * here, and that one is only read from where the last scan left off.
 */
const scanCache = new Map<string, { size: number; tail: TranscriptTail }>();

/**
 * Reads the transcript backwards for the two entries of which the *last* one counts, to the
 * beginning where a session has no session_info at all, since a rename made 300 KB of transcript
 * ago is still the name.
 */
function scanTail(filePath: string): Promise<TranscriptTail> {
  return scanTranscriptTail(filePath, scanCache, {
    byteLimit: TAIL_SCAN_BYTE_LIMIT,
    label: "pi",
    create: (): TranscriptTail => ({}),
    read: (lines, tail) => {
      readTailEntries(lines, tail);
      return tail.name !== undefined && tail.turnEndedAt !== undefined;
    },
    merge: (tail, previous) => {
      tail.name ??= previous.name;
      tail.turnEndedAt ??= previous.turnEndedAt;
    }
  });
}

function readTailEntries(lines: string[], tail: TranscriptTail): void {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!TAIL_ENTRY_TYPES.some((type) => line.includes(type))) {
      continue;
    }
    const entry = parseLine(line);
    if (!entry) {
      continue;
    }
    if (tail.name === undefined && entry.type === "session_info") {
      tail.name = typeof entry.name === "string" ? entry.name.trim() : "";
    } else if (tail.turnEndedAt === undefined && entry.type === "message") {
      const message = entry.message as Record<string, unknown> | undefined;
      if (message?.role !== "assistant") {
        continue;
      }
      const ms = typeof message.timestamp === "number" ? message.timestamp : Date.parse(nonEmptyString(entry.timestamp) ?? "");
      if (Number.isFinite(ms)) {
        tail.turnEndedAt = ms;
      }
    }
  }
}
