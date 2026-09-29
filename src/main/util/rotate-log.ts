import * as fs from "node:fs";

/** Moves a log of `maxBytes` or more to `<file>.1`, replacing the one there; no log yet is left
 *  alone. Throws when the move fails, for the caller to decide. */
export function rotateLog(file: string, maxBytes: number): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size >= maxBytes) {
    fs.renameSync(file, `${file}.1`);
  }
}
