import type { NoticeSeverity } from "../shared/types/app";
import { appendLog, openErrorLog } from "./util/error-log";

/**
 * Uncaught main-process exceptions. Electron's default modal dialog would freeze every terminal,
 * since this process relays all pty output. Such faults exist beyond any `try` — e.g. `write
 * EAGAIN` on a socket the other side dropped. The user gets a notice; the stack goes to `errors.log`.
 */

/** Starts every report; test/e2e/app.test.ts fails a run on it. */
export const UNCAUGHT_MARKER = "[TET] uncaught exception";

/** One notice per distinct error per run; every occurrence is still logged, numbered. */
const seen = new Map<string, number>();

export function installUncaughtHandler(logFile: string, notice: (severity: NoticeSeverity, message: string) => void): void {
  openErrorLog(logFile);
  // Unhandled rejections arrive here too; `origin` tells them apart.
  process.on("uncaughtException", (error: unknown, origin: string) => {
    const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const count = (seen.get(summary) ?? 0) + 1;
    seen.set(summary, count);
    const stack = error instanceof Error ? (error.stack ?? summary) : summary;
    const report = `${UNCAUGHT_MARKER} (${origin}, #${count}) ${new Date().toISOString()}\n${stack}\n`;
    // Console too: tests driving the app read stderr.
    appendLog(report);
    if (count === 1) {
      notice(
        "error",
        `TET hit an unexpected error and kept running: ${summary}. The details are in errors.log in TET's data folder (~/.tet).`,
      );
    }
  });
}
