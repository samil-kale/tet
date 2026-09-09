import * as fs from "node:fs";
import type { NoticeSeverity } from "../shared/types";

/**
 * What an uncaught exception in the main process does instead of ending the session.
 *
 * Electron's default is a modal error dialog, and in tet that is the worst possible answer: the
 * main process relays every pty's output, so the dialog freezes every terminal in every project
 * — live agent turns among them — over a fault that often has nothing to do with them. The one
 * seen for real was a stream write failing *after* it was handed over (`write EAGAIN` on a
 * socket the other side had already dropped), which no `try` around the call can catch and which
 * costs the app nothing to survive.
 *
 * The trade is real and this is the honest half of it: an exception nobody handled may well have
 * left something half-done, and swallowing it hides that. So nothing is swallowed quietly — the
 * user gets a notice naming the error, and the full stack goes to `errors.log` beside the
 * settings, the same "written every session, not behind a switch" bargain `event-loop.log`
 * makes: by the time a fault is worth investigating, the run that produced it is over.
 */

/** Rotated like the event loop's log, so a long-lived profile never grows one without end. */
const MAX_LOG_BYTES = 512 * 1024;

/** Every report starts with this — what test/app.test.ts fails a run on, and what to grep for. */
export const UNCAUGHT_MARKER = "[tet] uncaught exception";

/** One notice per distinct error per run: a fault that repeats every second must not become a
 *  stream of notices, but every occurrence is still logged, numbered. */
const seen = new Map<string, number>();

export function installUncaughtHandler(logFile: string, notify: (severity: NoticeSeverity, message: string) => void): void {
  try {
    if (fs.statSync(logFile).size >= MAX_LOG_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // No log yet, or it cannot be rotated — either way the append below is what matters.
  }
  // An unhandled promise rejection arrives here too: node's own default is to re-throw it as
  // an uncaught exception, which is exactly what this handler is for. `origin` says which it was.
  process.on("uncaughtException", (error: unknown, origin: string) => {
    const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const count = (seen.get(summary) ?? 0) + 1;
    seen.set(summary, count);
    const stack = error instanceof Error ? (error.stack ?? summary) : summary;
    const report = `${UNCAUGHT_MARKER} (${origin}, #${count}) ${new Date().toISOString()}\n${stack}\n`;
    // Both, and console first: the log is what survives the run, but a test driving the app
    // reads its stderr, and a developer running `npm start` is watching that console.
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
