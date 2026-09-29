import { writeIfChanged } from "./write-if-changed";

/**
 * Line endings and quoting for files tet generates for other processes to run (control
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
