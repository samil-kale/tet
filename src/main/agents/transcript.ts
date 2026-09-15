import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Shared reading of append-only JSONL transcripts from the end: the chunked read, title rules,
 * directory lookup. Entry types and the stop test live in each agent's `sessions.ts`.
 */

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
 * Evicts cached transcripts in `dir` no longer among `files` (the agent's picker deletes them
 * behind tet's back). Scoped to `dir`: a sandbox root (SessionProvider.sandbox) shares these
 * caches, and each pass would evict the other root's entries.
 */
export function forgetMissing(dir: string, files: string[], caches: Map<string, unknown>[]): void {
  const present = new Set(files.map((file) => path.join(dir, file)));
  for (const cache of caches) {
    for (const filePath of cache.keys()) {
      if (path.dirname(filePath) === dir && !present.has(filePath)) {
        cache.delete(filePath);
      }
    }
  }
}

/** Transcript fields are untrusted JSON — a title only counts if it's a non-blank string. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
export async function readLinesBackwards(
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
export interface TailScan<T> {
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

/**
 * Reads a transcript backwards for the agent's `read`, answering an unchanged file from `cache`.
 * A grown file is read only down to a chunk below the previous scan's end, the rest merged from
 * the old answer — the overlap covers a line caught half-written. The caller owns and evicts the cache.
 */
export async function scanTranscriptTail<T>(
  filePath: string,
  cache: Map<string, { size: number; tail: T }>,
  scan: TailScan<T>
): Promise<T> {
  const tail = scan.create();
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const { size } = await handle.stat();
    const cached = cache.get(filePath);
    if (cached?.size === size) {
      return cached.tail;
    }
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
  } finally {
    await handle?.close();
  }
  return tail;
}
