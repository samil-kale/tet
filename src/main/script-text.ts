import writeFileAtomic from "write-file-atomic";

/**
 * Line endings and quoting for files tet generates for other processes to run (control
 * launchers).
 */

/** sh chokes on CRLF (`then\r`), whatever the source's line endings. Executable: run directly
 *  from PATH. */
export function writePosixScript(file: string, contents: string): void {
  writeFileAtomic.sync(file, contents.replace(/\r\n/g, "\n"), { mode: 0o755 });
}

/** A POSIX sh single-quoted string, safe for any content. */
export function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
