import * as fs from "node:fs";

/**
 * Encoding, line endings and quoting for files tet generates for other processes to run (control
 * launchers).
 */

/** sh chokes on CRLF (`then\r`), whatever the source's line endings. */
export function writePosixScript(file: string, contents: string): void {
  fs.writeFileSync(file, contents.replace(/\r\n/g, "\n"));
}

/** A POSIX sh single-quoted string, safe for any content. */
export function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
