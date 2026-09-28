/** What the shell (PowerShell on win32, else `$SHELL`) reads as is: no `$`, backtick, quote, space,
 *  `,` (a PowerShell array) or, outside win32, backslash (an escape). */
const PLAIN_PATH = process.platform === "win32" ? /^[\w./\\:-]+$/ : /^[\w./:-]+$/;

/** Single-quoted, since PowerShell and POSIX shells expand `$` and a backtick inside double quotes
 *  too; a `'` in it is doubled (PowerShell) or closed, escaped and reopened (POSIX). */
export function shellQuotePath(filePath: string): string {
  if (PLAIN_PATH.test(filePath)) {
    return filePath;
  }
  return process.platform === "win32" ? `'${filePath.replace(/'/g, "''")}'` : `'${filePath.replace(/'/g, "'\\''")}'`;
}
