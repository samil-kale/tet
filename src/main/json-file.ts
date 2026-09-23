import writeFileAtomic from "write-file-atomic";

/** A parsed JSON object; an array or null is not one. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Writes one of tet's own files as indented JSON, renamed into place; a failure is logged as
 *  "could not persist <what>", never thrown. */
export function saveJson(file: string, value: unknown, what: string): void {
  try {
    writeFileAtomic.sync(file, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    console.error(`[tet] could not persist ${what}:`, error);
  }
}
