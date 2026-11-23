import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

/** Neither follows a link nor waits on a pipe; 0 where the platform has no such flag. */
const OPEN_AS_IS = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** The plain file's text at `file`; undefined for anything else (missing, a link, a pipe). */
function plainFileText(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | OPEN_AS_IS);
  } catch {
    return undefined;
  }
  try {
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, "utf8") : undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes `contents` renamed into place, and only when they differ from the file's: a generated
 *  file another process may be reading, rewritten at every setup, and nearly always unchanged —
 *  the read spares the main process a synchronous write and fsync. Some lie in a folder a sandbox
 *  writes into: a link or pipe at `file` is replaced, never followed or waited on. */
export function writeIfChanged(file: string, contents: string, options?: { mode?: number }): void {
  if (plainFileText(file) === contents) {
    return;
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx", options?.mode ?? 0o666);
    try {
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // The open's mode is cut by the umask; an executable launcher needs its bits whole.
    if (options?.mode !== undefined) {
      fs.chmodSync(temp, options.mode);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Line endings and quoting for files TET generates for other processes to run (control
 * launchers). git's `askpass.sh` is one too, written in `git/askpass.ts`, which may not import this: LF by
 * its own `join("\n")`, nothing interpolated.
 */

/** sh chokes on CRLF (`then\r`), whatever the source's line endings. Executable: run directly
 *  from PATH. */
export function writePosixScript(file: string, contents: string): void {
  writeIfChanged(file, contents.replace(/\r\n/g, "\n"), { mode: 0o755 });
}

/** A POSIX sh single-quoted string, safe for any content. Whatever is written into a generated sh
 *  script goes through it. */
export function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
