import * as fs from "node:fs";
import type { NoticeSeverity } from "../shared/types";
import { rotateLog } from "./util/rotate-log";

/**
 * Uncaught main-process exceptions. Electron's default modal dialog would freeze every terminal,
 * since this process relays all pty output. Such faults exist beyond any `try` — e.g. `write
 * EAGAIN` on a socket the other side dropped. The user gets a notice; the stack goes to `errors.log`.
 */

/** Past this size errors.log is rotated. */
const MAX_LOG_BYTES = 512 * 1024;

/** Starts every report; test/app.test.ts fails a run on it. */
export const UNCAUGHT_MARKER = "[tet] uncaught exception";

/** One notice per distinct error per run; every occurrence is still logged, numbered. */
const seen = new Map<string, number>();

/** Set by installUncaughtHandler. */
let errorLog: string | undefined;

/** Logs a failure that would go unseen — a caught exception with its stack, or none (e.g. a refused
 *  toast); never throws. The console gets it too, for tests driving the app. */
export function logError(line: string, error?: unknown): void {
  const detail = error === undefined ? "" : `\n${error instanceof Error ? (error.stack ?? String(error)) : String(error)}`;
  const entry = `[tet] ${line} ${new Date().toISOString()}${detail}\n`;
  console.error(entry);
  if (!errorLog) {
    return;
  }
  try {
    fs.appendFileSync(errorLog, entry);
  } catch {
    // Console copy only.
  }
}

export function installUncaughtHandler(logFile: string, notify: (severity: NoticeSeverity, message: string) => void): void {
  errorLog = logFile;
  try {
    rotateLog(logFile, MAX_LOG_BYTES);
  } catch {
    // Not rotatable.
  }
  // Unhandled rejections arrive here too; `origin` tells them apart.
  process.on("uncaughtException", (error: unknown, origin: string) => {
    const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const count = (seen.get(summary) ?? 0) + 1;
    seen.set(summary, count);
    const stack = error instanceof Error ? (error.stack ?? summary) : summary;
    const report = `${UNCAUGHT_MARKER} (${origin}, #${count}) ${new Date().toISOString()}\n${stack}\n`;
    // Console too: tests driving the app read stderr.
    console.error(report);
    try {
      fs.appendFileSync(logFile, report);
    } catch {
      // Logging must not itself throw.
    }
    if (count === 1) {
      notify("error", `TET hit an unexpected error and kept running: ${summary}. The details are in errors.log in TET's data folder (~/.tet).`);
    }
  });
}
