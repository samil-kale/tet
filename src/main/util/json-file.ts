import * as fs from "node:fs";
import writeFileAtomic from "write-file-atomic";

/** A parsed JSON object; an array or null is not one. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One of tet's own files, parsed; undefined where there is none yet or it cannot be read — the
 *  store then starts empty, and its next save writes over it. The shape is the caller's to check. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Whether `entry` is an object holding a string under each of `keys`. */
export function hasStrings(entry: unknown, ...keys: string[]): entry is Record<string, unknown> {
  return isRecord(entry) && keys.every((key) => typeof entry[key] === "string");
}

/** A store's file of rows (`readJson`): those holding a string under each of `strings` that
 *  `accepts` takes, the rest dropped; no array is no rows. */
export function readRows<T>(
  file: string,
  strings: string[],
  accepts: (entry: Record<string, unknown>) => boolean = () => true
): T[] {
  const parsed = readJson(file);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is T => hasStrings(entry, ...strings) && accepts(entry))
    : [];
}

/** Writes one of tet's own files as indented JSON, renamed into place; throws when it cannot. For a
 *  store written from a Save someone waits on: its failure is theirs to see, and the store changes
 *  its contents only once the file has them. */
export function writeJson(file: string, value: unknown): void {
  writeFileAtomic.sync(file, JSON.stringify(value, null, 2), "utf8");
}

/** A store's write nobody waits on, or a cleanup that must not stop what it cleans up after: a
 *  failure is logged as "could not <what>", never thrown. */
export function logFailure(what: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    console.error(`[tet] could not ${what}:`, error);
  }
}
