import * as fs from "node:fs";
import { inspect } from "node:util";

/** Past this size errors.log is rotated. */
const MAX_LOG_BYTES = 512 * 1024;

/** Set by openErrorLog. */
let errorLog: string | undefined;

/** errors.log's size as this process counts it: read at open, then what it appended. */
let logBytes = 0;

/** Where logError writes from now on; one of `MAX_LOG_BYTES` or more is moved to `<file>.1`,
 *  replacing the one there — first, and again whenever the appends reach it. */
export function openErrorLog(file: string): void {
  errorLog = file;
  try {
    logBytes = fs.statSync(file).size;
  } catch {
    // No log yet.
    logBytes = 0;
  }
  rotateFull(file);
}

function rotateFull(file: string): void {
  if (logBytes < MAX_LOG_BYTES) {
    return;
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    // `.1` locked or a folder: emptied instead, or every entry would try again and the log grow on.
    try {
      fs.truncateSync(file);
    } catch {
      return;
    }
  }
  logBytes = 0;
}

/** Logs a failure that would go unseen — a caught exception with its stack, or none (e.g. a refused
 *  notification); never throws. The console gets it too, for tests driving the app. */
export function logError(line: string, error?: unknown): void {
  const detail =
    error === undefined
      ? ""
      : `\n${error instanceof Error ? (error.stack ?? String(error)) : typeof error === "string" ? error : inspect(error)}`;
  appendLog(`[TET] ${line} ${new Date().toISOString()}${detail}\n`);
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
    logBytes += Buffer.byteLength(entry);
    rotateFull(errorLog);
  } catch {
    // Console copy only.
  }
}
