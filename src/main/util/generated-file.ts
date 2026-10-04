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

/**
 * Line endings and quoting for files TET generates for other processes to run (control
 * launchers). git's `askpass.sh` is one too, written in `git.ts`, which may not import this: LF by
 * its own `join("\n")`, nothing interpolated.
 */

/** sh chokes on CRLF (`then\r`), whatever the source's line endings. Executable: run directly
 *  from PATH. */
export function writePosixScript(file: string, contents: string): void {
  writeIfChanged(file, contents.replace(/\r\n/g, "\n"), { mode: 0o755 });
}

/** A POSIX sh single-quoted string, safe for any content. */
export function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
