import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import {
  findEncodedDir,
  listTranscriptDir,
  nonEmptyString,
  parseLine,
  requireTitle,
  scanTranscriptHead,
  scanTranscriptTail,
  timestampOf,
  TRANSCRIPT_SCAN_BYTES,
  truncateTitle,
  type ScannedTail
} from "../transcript";
import { watchTranscriptDir } from "../../watch-dir";
import { SANDBOX_HOME } from "../../terminals/hook-target";

/**
 * pi keeps one JSONL transcript per session, `<ISO timestamp, ":" and "." as "-">_<uuid>.jsonl`,
 * in a directory encoding the cwd (encodeCwd):
 *
 * - line 1 is the header `{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>",
 *   "cwd":"<path>"}`; its id is what `--session` matches
 * - later lines are entries with an 8-hex `id`, a `parentId` (a tree: pi branches in place) and an
 *   ISO `timestamp`; `message` entries carry `message.role` and, for the assistant, `stopReason`
 *   (`"aborted"` for an Escape-abort)
 * - the file appears with the first assistant message; harmless, since turns are reported per tab
 * - the display name is the LAST `session_info` in file order, whatever its tree position, a blank
 *   one clearing it; without one pi shows the first user message
 */
export const piSessionProvider: SessionProvider = {
  list(cwd: string): Promise<AgentSessionInfo[]> {
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

  /** The session directory may not exist yet — watchTranscriptDir handles that. */
  watch(cwd: string, onChange: () => void): () => void {
    return watchTranscriptDir(
      sessionsRoot,
      () => findSessionDir(sessionsRoot(), cwd),
      (filename) => filename.endsWith(".jsonl"),
      onChange
    );
  },

  /** The sandbox's default `~/.pi/agent/sessions` (`PI_CODING_AGENT_DIR` is never set); `auth.json`
   *  sits beside it, not in it. */
  sandbox: {
    mounts: [{ sub: "sessions", target: `${SANDBOX_HOME}/.pi/agent/sessions` }],
    list: (root, cwd) => listIn(path.join(root, "sessions"), cwd, path.posix),
    remove: (root, cwd, sessionId) => removeIn(path.join(root, "sessions"), cwd, sessionId, path.posix),
    rename: (root, cwd, sessionId, title) =>
      renameIn(path.join(root, "sessions"), cwd, sessionId, title, path.posix)
  }
};

function listIn(root: string, cwd: string, paths = path): Promise<AgentSessionInfo[]> {
  return listTranscriptDir(
    () => findSessionDir(root, cwd, paths),
    [headCache, scanCache],
    "pi",
    async (filePath): Promise<AgentSessionInfo | undefined> => {
      // The tail first, for the size its fstat gives the head scan.
      const { tail, size, mtimeMs } = await scanTail(filePath);
      const head = await scanHead(filePath, size);
      if (head.id === undefined) {
        return undefined;
      }
      return {
        id: head.id,
        title: tail.name ? truncateTitle(tail.name) : (head.firstPrompt ?? ""),
        // mtime: only compared for change, and a rename bumps it.
        updatedAt: mtimeMs,
        createdAt: head.createdAt ?? mtimeMs,
        turnEndedAt: tail.turnEndedAt
        // No provisionalTitle: pi never names a session, so reconcile would poll in vain.
      };
    }
  );
}

/** A missing session directory or transcript resolves (SessionProvider.remove): already gone. */
async function removeIn(root: string, cwd: string, sessionId: string, paths = path): Promise<void> {
  const dir = await findSessionDir(root, cwd, paths);
  if (!dir) {
    return;
  }
  const filePath = await findSessionFile(dir, sessionId);
  if (!filePath) {
    return;
  }
  // pi keeps no per-session directory.
  await fs.promises.rm(filePath, { force: true });
  headCache.delete(filePath);
  scanCache.delete(filePath);
}

/**
 * Mirrors pi's `/name` (appendSessionInfo): a `session_info` entry parented to the last entry. Safe
 * while pi runs on the file; a running pi shows the name only after a restart.
 */
async function renameIn(root: string, cwd: string, sessionId: string, title: string, paths = path): Promise<void> {
  const trimmed = requireTitle(title);
  const dir = await findSessionDir(root, cwd, paths);
  if (!dir) {
    throw new Error("pi session directory not found");
  }
  const filePath = await findSessionFile(dir, sessionId);
  if (!filePath) {
    throw new Error("pi session not found");
  }
  // The whole file: the new id must be unique across it (pi keys its tree by id); renames are rare.
  const text = await fs.promises.readFile(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const last = parseLine(lines[lines.length - 1] ?? "");
  if (!last) {
    throw new Error("pi transcript is not readable");
  }
  // An entry right after the header is a root (parentId null), as pi writes its first entry.
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
 * `PI_CODING_AGENT_DIR` is the documented override (the tests set it). `PI_CODING_AGENT_SESSION_DIR`
 * and settings.json's `sessionDir` are not honoured: the latter means reading the user's config.
 */
function sessionsRoot(): string {
  return path.join(piAgentDir(), "sessions");
}

/** pi's agent dir, where its sessions and knowledge live; tet never sets it. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/**
 * pi's cwd encoding (getDefaultSessionDirPath): the resolved path minus a leading `/` or `\`, each
 * `/`, `\` and `:` as `-`, wrapped in `--` (`C:\Users\x\repo` → `--C--Users-x-repo--`). `paths` is
 * pi's platform: a sandboxed pi resolves `/c/Users/x/repo` the POSIX way, not as `C:\c\Users…`.
 */
export function encodeCwd(cwd: string, paths: path.PlatformPath = path): string {
  return `--${paths.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * The repository's transcript directory, if pi ever ran here. On win32 the drive letter's case
 * follows the spawn, so findEncodedDir matches case-insensitively.
 */
function findSessionDir(root: string, cwd: string, paths = path): Promise<string | undefined> {
  return findEncodedDir(root, encodeCwd(cwd, paths));
}

/** A session's transcript, by filename uuid or, for a file pi renamed or forked, by header id.
 *  Undefined means "already gone" to a removal. */
async function findSessionFile(dir: string, sessionId: string): Promise<string | undefined> {
  const files = (await fs.promises.readdir(dir)).filter((file) => file.endsWith(".jsonl"));
  const named = files.find((file) => file.endsWith(`_${sessionId}.jsonl`));
  if (named) {
    return path.join(dir, named);
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    const head = await scanHead(filePath, (await fs.promises.stat(filePath)).size);
    if (head.id === sessionId) {
      return filePath;
    }
  }
  return undefined;
}

interface TranscriptHead {
  /** What `--session` matches; undefined for a `.jsonl` that is not a pi transcript. */
  id?: string;
  /** Header timestamp, ms; written at pi's startup, so always after the tab's spawn. */
  createdAt?: number;
  /** Truncated; pi's picker shows the same. */
  firstPrompt?: string;
}

/** Keyed by how much of the window the file fills: only the first TRANSCRIPT_SCAN_BYTES of an
 *  append-only file are read. */
const headCache = new Map<string, { size: number; head: TranscriptHead }>();

function scanHead(filePath: string, fileSize: number): Promise<TranscriptHead> {
  return scanTranscriptHead(filePath, fileSize, headCache, {
    label: "pi",
    create: (): TranscriptHead => ({}),
    read: (line, head) => {
      if (head.id === undefined) {
        // Like pi's listing, skip a file whose first line is not a header.
        const header = parseLine(line);
        const id = header?.type === "session" ? nonEmptyString(header.id) : undefined;
        if (id === undefined) {
          return true;
        }
        head.id = id;
        head.createdAt = timestampOf(header?.timestamp);
        return false;
      }
      // Only the first user message; other lines go unparsed.
      if (!line.includes('"user"')) {
        return false;
      }
      const entry = parseLine(line);
      const message = entry?.type === "message" ? (entry.message as Record<string, unknown> | undefined) : undefined;
      if (message?.role !== "user") {
        return false;
      }
      const prompt = messageText(message.content);
      head.firstPrompt = prompt === undefined ? undefined : truncateTitle(prompt);
      return true;
    }
  });
}

/** A plain string, or its `text` blocks joined — as pi's picker reads it. */
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

interface TranscriptTail {
  /** The last session_info's name, trimmed; "" clears it (pi reads `entry.name?.trim() || undefined`). */
  name?: string;
  /** The last assistant message's time, however its turn ended (an Escape-abort is one with
   *  `stopReason: "aborted"`), bar one calling a tool. Its ms timestamp, else the entry's ISO one, as pi's
   *  getMessageActivityTime reads it. */
  turnEndedAt?: number;
}

/** Only lines naming one of these are parsed — most of a transcript is tool output. */
const TAIL_ENTRY_TYPES = ['"session_info"', '"assistant"'];

/** The last scan per path; only a growing transcript is read again, from where that scan ended. */
const scanCache = new Map<string, { size: number; tail: TranscriptTail }>();

/**
 * Reads backwards for the two entries whose *last* occurrence counts, to the file's start if needed
 * — an old rename is still the name.
 */
function scanTail(filePath: string): Promise<ScannedTail<TranscriptTail>> {
  return scanTranscriptTail(filePath, scanCache, {
    byteLimit: TRANSCRIPT_SCAN_BYTES,
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
      // pi writes each assistant message as it ends, and one calling a tool is mid-turn.
      if (message?.role !== "assistant" || message.stopReason === "toolUse") {
        continue;
      }
      const ms = typeof message.timestamp === "number" ? message.timestamp : timestampOf(entry.timestamp);
      if (ms !== undefined && Number.isFinite(ms)) {
        tail.turnEndedAt = ms;
      }
    }
  }
}
