import * as fs from "node:fs";
import type { NoticeSeverity } from "../shared/types";

/**
 * What an uncaught exception in the main process does instead of ending the session. Electron's
 * default is a modal error dialog, and the main process relays every pty's output, so that dialog
 * freezes every terminal in every project — live agent turns among them — over a fault that often
 * has nothing to do with them. Seen for real: a stream write failing *after* it was handed over
 * (`write EAGAIN` on a socket the other side had dropped), which no `try` can catch. Nothing is
 * swallowed silently — the user gets a notice naming the error, and the full stack goes to
 * `errors.log` beside the settings, written every session rather than behind a switch.
 */

/** Rotated like the event loop's log, so a long-lived profile never grows one without end. */
const MAX_LOG_BYTES = 512 * 1024;

/** Every report starts with this — what test/app.test.ts fails a run on, and what to grep for. */
export const UNCAUGHT_MARKER = "[tet] uncaught exception";

/** One notice per distinct error per run; every occurrence is still logged, numbered. */
const seen = new Map<string, number>();

export function installUncaughtHandler(logFile: string, notify: (severity: NoticeSeverity, message: string) => void): void {
  try {
    if (fs.statSync(logFile).size >= MAX_LOG_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // No log yet, or it cannot be rotated — the append below is what matters.
  }
  // An unhandled promise rejection arrives here too — node re-throws it as an uncaught
  // exception. `origin` says which it was.
  process.on("uncaughtException", (error: unknown, origin: string) => {
    const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const count = (seen.get(summary) ?? 0) + 1;
    seen.set(summary, count);
    const stack = error instanceof Error ? (error.stack ?? summary) : summary;
    const report = `${UNCAUGHT_MARKER} (${origin}, #${count}) ${new Date().toISOString()}\n${stack}\n`;
    // Both, console first: the log survives the run, but a test driving the app reads stderr.
    console.error(report);
    try {
      fs.appendFileSync(logFile, report);
    } catch {
      // The console copy above is all there is then; a failure to log must not itself throw.
    }
    if (count === 1) {
      notify("error", `TET hit an unexpected error and kept running: ${summary}. The details are in errors.log in TET's data folder.`);
    }
  });
}
