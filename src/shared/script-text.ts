import * as fs from "node:fs";

/**
 * What a file tet generates for another process to run has to get right whatever is in it: how
 * PowerShell decodes it, how `sh` reads its line endings, and how a path or a name written into
 * one stays a single word. Used by the control launchers and the shell transcript; nothing here
 * knows what it is writing.
 */

/** PowerShell 5.1 decodes a BOM-less file as ANSI, so anything it will read needs this. */
export const WIN_BOM = "﻿";

/** sh chokes on CRLF (`then\r`, `fi\r`), whatever line endings the source file was stored with. */
export function writePosixScript(file: string, contents: string): void {
  fs.writeFileSync(file, contents.replace(/\r\n/g, "\n"));
}

/** Wraps a value as a POSIX sh single-quoted string, safe for any content. */
export function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
