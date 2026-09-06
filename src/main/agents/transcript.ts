import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What Claude Code's and Codex's session providers share about reading a transcript: both are
 * append-only JSONL files read from the end, since what a listing wants — the last turn's end,
 * the latest title — sits there. The entry types and the "found what I came for" test are each
 * agent's own (each `sessions.ts` under `src/main/agents/`); the chunked read, the title rules
 * and the lookup of a per-repository directory are not.
 */

/**
 * The directory `root/<encoded>`, for an agent that keeps one per repository under a name
 * derived from its path (Claude Code, pi), or undefined where the agent has never run in it.
 * Windows paths are case-insensitive and the CLIs preserve whatever casing they saw — pi's
 * drive letter follows the spawn, Claude Code's whole path does — so the same repository can
 * have differently-cased directories there, and the match ignores case on win32. No root at
 * all (the agent has never run on this machine) is the same answer as no directory for this
 * repository: no sessions, not a failure to report.
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

/** Transcript fields are untrusted JSON — a title only counts if it's a non-blank string. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A tab title's length, what the strip has room for. */
const TITLE_MAX_LENGTH = 60;

export function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > TITLE_MAX_LENGTH ? `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…` : normalized;
}

/**
 * Hands `onLines` the file's lines from `size` down to `floor`, one chunk of `chunkBytes` at a
 * time and later chunks first, until `onLines` returns true or `floor` is reached. Every line
 * arrives whole: the bytes before a chunk's first newline are the tail of a line the next chunk
 * up ends, and are carried over as bytes, so a character cut in two survives — except at
 * `floor`, where the partial line is handed over as it is (a scan resuming above an earlier one
 * overlaps it by a chunk for exactly that reason).
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
