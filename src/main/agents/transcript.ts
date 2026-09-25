import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { isRecord } from "../json-file";
import type { AgentSessionInfo } from "./agent";

/**
 * Shared reading of append-only JSONL transcripts from either end: the chunked read, title rules,
 * directory lookup. Entry types and the stop test live in each agent's `sessions.ts`.
 */

/**
 * How much of a transcript either scan reads. Bounds a pathological single line; forwards it also
 * has to hold what the agent writes before the first prompt (Codex's `session_meta` carries the
 * whole base instructions, measured at 0.14x of this).
 */
export const TRANSCRIPT_SCAN_BYTES = 256 * 1024;

/**
 * The directory `root/<encoded>` of an agent keeping one per repository (Claude Code, pi), or
 * undefined. The CLIs keep the path casing they saw (pi's drive letter, Claude Code's whole
 * path), so win32 matches case-insensitively. A missing root means no sessions, not a failure.
 */
export async function findEncodedDir(root: string, encoded: string): Promise<string | undefined> {
  const ignoreCase = process.platform === "win32";
  const wanted = ignoreCase ? encoded.toLowerCase() : encoded;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  for (const entry of entries) {
    if ((ignoreCase ? entry.toLowerCase() : entry) === wanted) {
      return path.join(root, entry);
    }
  }
  return undefined;
}

/**
 * A listing's shared frame: the sessions `list` resolves, oldest first, or [] on any failure
 * (SessionProvider.list), logged under `label`. Undefined entries are files that are no session.
 */
export async function collectSessions(
  label: string,
  list: () => Promise<(AgentSessionInfo | undefined)[]>
): Promise<AgentSessionInfo[]> {
  try {
    const sessions = (await list()).filter((entry): entry is AgentSessionInfo => entry !== undefined);
    sessions.sort((a, b) => a.createdAt - b.createdAt);
    return sessions;
  } catch (error) {
    console.error(`[tet] ${label} session listing failed:`, error);
    return [];
  }
}

/**
 * Lists an agent keeping one directory of `.jsonl` transcripts per repository (Claude Code, pi):
 * evicts what left the directory from `caches`, then hands `readOne` every transcript. No
 * directory means no sessions.
 */
export function listTranscriptDir(
  findDir: () => Promise<string | undefined>,
  caches: Map<string, unknown>[],
  label: string,
  readOne: (filePath: string, file: string) => Promise<AgentSessionInfo | undefined>
): Promise<AgentSessionInfo[]> {
  return collectSessions(label, async () => {
    const dir = await findDir();
    if (!dir) {
      return [];
    }
    const files = (await fs.promises.readdir(dir)).filter((file) => file.endsWith(".jsonl"));
    forgetMissing(
      dir,
      files.map((file) => path.join(dir, file)),
      caches
    );
    return Promise.all(files.map((file) => readOne(path.join(dir, file), file)));
  });
}

/**
 * Evicts cached transcripts under `root` no longer among `present` (the agent's picker deletes
 * them behind tet's back); both are absolute paths. Scoped to `root`: a sandbox root
 * (SessionProvider.sandbox) shares these caches, and each pass would evict the other root's
 * entries. A prefix, so it serves an agent keeping its transcripts in one directory and one
 * nesting them (Codex's `YYYY/MM/DD`) alike.
 */
export function forgetMissing(root: string, present: string[], caches: Map<string, unknown>[]): void {
  const kept = new Set(present);
  const prefix = root + path.sep;
  for (const cache of caches) {
    for (const filePath of cache.keys()) {
      if (filePath.startsWith(prefix) && !kept.has(filePath)) {
        cache.delete(filePath);
      }
    }
  }
}

/** Transcript fields are untrusted JSON — a title only counts if it's a non-blank string. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** One JSONL entry, or undefined for a line that is not an object — a half-written last line, or
 *  a `.jsonl` that is not a transcript at all. */
export function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** An entry's ISO timestamp as ms, or undefined where it is missing or unparseable. */
export function timestampOf(value: unknown): number | undefined {
  const ms = Date.parse(nonEmptyString(value) ?? "");
  return Number.isNaN(ms) ? undefined : ms;
}

/** A title the user typed, or the refusal every `SessionProvider.rename` answers for a blank one. */
export function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("title must be non-empty");
  }
  return trimmed;
}

/**
 * Hands `onLine` the transcript's lines from the start until it returns true or the window ends —
 * the forward counterpart to `readLinesBackwards`, for what only the head of a file says (the
 * session's id, when it began, the first prompt).
 *
 * Answers whether the read itself held up: false means it failed (logged under `label`) and
 * `onLine` saw only part of the window, so a caller caching by size must not keep that answer.
 */
export async function readHeadLines(
  filePath: string,
  byteLimit: number,
  label: string,
  onLine: (line: string) => boolean
): Promise<boolean> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: byteLimit });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (onLine(line)) {
        return true;
      }
    }
    return true;
  } catch (error) {
    console.error(`[tet] ${label} transcript head scan failed:`, error);
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** The per-agent, format-specific half of a cached head scan; `scanTranscriptHead` handles the file. */
interface HeadScan<T> {
  /** Names the agent in a failed scan's log. */
  label: string;
  create: () => T;
  /** Takes one line into `head`; true once nothing further is wanted. */
  read: (line: string, head: T) => boolean;
}

/**
 * Reads a transcript's head window for the agent's `read`, answering from `cache` while the file
 * fills as much of the window as it did: transcripts are append-only, so a full window never
 * changes. A failed read is not cached. The caller owns and evicts the cache.
 */
export async function scanTranscriptHead<T>(
  filePath: string,
  fileSize: number,
  cache: Map<string, { size: number; head: T }>,
  scan: HeadScan<T>
): Promise<T> {
  const size = Math.min(fileSize, TRANSCRIPT_SCAN_BYTES);
  const cached = cache.get(filePath);
  if (cached?.size === size) {
    return cached.head;
  }
  const head = scan.create();
  const read = await readHeadLines(filePath, TRANSCRIPT_SCAN_BYTES, scan.label, (line) => scan.read(line, head));
  if (read) {
    cache.set(filePath, { size, head });
  }
  return head;
}

/** What the tab strip has room for. */
const TITLE_MAX_LENGTH = 60;

export function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > TITLE_MAX_LENGTH ? `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…` : normalized;
}

/**
 * Hands `onLines` the file's lines from `size` down to `floor`, last chunk first, until it returns
 * true. Lines arrive whole: bytes before a chunk's first newline carry (as bytes, so a cut
 * character survives) into the next chunk — except at `floor`, where the partial line is handed
 * over as is; hence a resumed scan overlaps the earlier one by a chunk.
 */
async function readLinesBackwards(
  handle: fs.promises.FileHandle,
  size: number,
  floor: number,
  chunkBytes: number,
  onLines: (lines: string[]) => boolean
): Promise<void> {
  let end = size;
  let carry = Buffer.alloc(0);
  while (end > floor) {
    const start = Math.max(floor, end - chunkBytes);
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    let chunk = Buffer.concat([buffer, carry]);
    if (start > floor) {
      const cut = chunk.indexOf(10);
      carry = cut === -1 ? chunk : chunk.subarray(0, cut);
      chunk = cut === -1 ? Buffer.alloc(0) : chunk.subarray(cut + 1);
    }
    if (onLines(chunk.toString("utf8").split("\n"))) {
      return;
    }
    end = start;
  }
}

/** The per-agent, format-specific half of a cached tail scan; `scanTranscriptTail` handles the file. */
interface TailScan<T> {
  /** Bytes per chunk, and how far below an earlier scan the next one restarts. */
  byteLimit: number;
  /** Names the agent in a failed scan's log. */
  label: string;
  create: () => T;
  /** Takes one chunk's lines into `tail`; true once nothing further is wanted. */
  read: (lines: string[], tail: T) => boolean;
  /** Runs after the backward read, before `merge`. */
  finish?: (tail: T) => void;
  /** Fills what this scan did not find from the previous one. */
  merge: (tail: T, previous: T) => void;
}

/** A tail scan's answer, with the file's size and mtime from its own fstat — a listing stats no further. */
export interface ScannedTail<T> {
  tail: T;
  size: number;
  mtimeMs: number;
}

/**
 * Reads a transcript backwards for the agent's `read`, answering an unchanged file from `cache`.
 * A grown file is read only down to a chunk below the previous scan's end, the rest merged from
 * the old answer — the overlap covers a line caught half-written. The caller owns and evicts the cache.
 *
 * A file that cannot be opened or stat'ed rejects, failing the listing; a failed read is logged
 * and answers what it found.
 */
export async function scanTranscriptTail<T>(
  filePath: string,
  cache: Map<string, { size: number; tail: T }>,
  scan: TailScan<T>
): Promise<ScannedTail<T>> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const { size, mtimeMs } = await handle.stat();
    const cached = cache.get(filePath);
    if (cached?.size === size) {
      return { tail: cached.tail, size, mtimeMs };
    }
    const tail = scan.create();
    try {
      const previous = cached && cached.size < size ? cached : undefined;
      const floor = previous ? Math.max(0, previous.size - scan.byteLimit) : 0;
      await readLinesBackwards(handle, size, floor, scan.byteLimit, (lines) => scan.read(lines, tail));
      scan.finish?.(tail);
      if (previous) {
        scan.merge(tail, previous.tail);
      }
      cache.set(filePath, { size, tail });
    } catch (error) {
      console.error(`[tet] ${scan.label} transcript scan failed:`, error);
    }
    return { tail, size, mtimeMs };
  } finally {
    await handle.close();
  }
}
