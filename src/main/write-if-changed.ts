import * as fs from "node:fs";
import writeFileAtomic from "write-file-atomic";

/** Writes `contents` renamed into place, and only when they differ from the file's: a generated
 *  file another process may be reading, rewritten at every setup, and nearly always unchanged —
 *  the read spares the main process a synchronous write and fsync. */
export function writeIfChanged(file: string, contents: string, options?: { mode?: number }): void {
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== contents) {
    writeFileAtomic.sync(file, contents, options);
  }
}
