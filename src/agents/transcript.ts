import type * as fs from "node:fs";

/**
 * What Claude Code's and Codex's session providers share about reading a transcript: both are
 * append-only JSONL files read from the end, since what a listing wants — the last turn's end,
 * the latest title — sits there. The entry types and the "found what I came for" test are each
 * agent's own (each `sessions.ts` under `src/agents/`); the chunked read and the title rules are not.
 */

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
