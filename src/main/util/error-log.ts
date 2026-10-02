import * as fs from "node:fs";

/** Past this size errors.log is rotated. */
const MAX_LOG_BYTES = 512 * 1024;

/** Set by openErrorLog. */
let errorLog: string | undefined;

/** Where logError writes from now on; one of `MAX_LOG_BYTES` or more is first moved to
 *  `<file>.1`, replacing the one there. */
export function openErrorLog(file: string): void {
  errorLog = file;
  try {
    if (fs.statSync(file).size >= MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // No log yet, or not rotatable.
  }
}

/** Logs a failure that would go unseen — a caught exception with its stack, or none (e.g. a refused
 *  toast); never throws. The console gets it too, for tests driving the app. */
export function logError(line: string, error?: unknown): void {
  const detail = error === undefined ? "" : `\n${error instanceof Error ? (error.stack ?? String(error)) : String(error)}`;
  appendLog(`[tet] ${line} ${new Date().toISOString()}${detail}\n`);
}

/** Writes an entry as it stands, to the console and errors.log; never throws. */
export function appendLog(entry: string): void {
  // console.error ends the line itself.
  console.error(entry.trimEnd());
  if (!errorLog) {
    return;
  }
  try {
    fs.appendFileSync(errorLog, entry);
  } catch {
    // Console copy only.
  }
}
