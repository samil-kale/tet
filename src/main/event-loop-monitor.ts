import * as fs from "node:fs";

/**
 * How often the loop is sampled. A keystroke on its way to a pty waits in the same queue as
 * this timer, so how late the timer runs is how late the keystroke would be.
 */
const SAMPLE_MS = 20;
/** Below this, a late sample is scheduling noise rather than something a typist could feel. */
const STALL_MS = 50;
/** A stall this long is worth a line of its own, not just a tally. */
const LOUD_STALL_MS = 200;
/** One summary per interval, and only when there was something to report. */
const REPORT_MS = 60_000;
/**
 * Below this, a single measured block is scheduling noise the same way a short stall is; above
 * it, worth a line naming the block itself rather than leaving it to the "ran last" guess.
 */
const SLOW_MS = 100;
/**
 * The log is appended across sessions, so a stall can still be looked up days after the run
 * that produced it; once past this size it is rotated to `<file>.1`, replacing the previous
 * generation, so at most two files of this size ever exist.
 */
const MAX_LOG_BYTES = 1_000_000;

/**
 * The main process's continuous work, in the places it happens. Nothing here is a guess about
 * cost — the point is to find out which of them the loop is actually sitting in.
 */
export type Activity = "output" | "input" | "sse" | "reconcile" | "git" | "emit";

const counts = new Map<Activity, number>();
/**
 * What ran last. A stall is only noticed by the sample that follows it, so whatever was
 * running just before is the likeliest thing to have blocked it — a guess `logSlow` doesn't
 * need, since it times the block directly.
 */
let lastActivity: Activity | undefined;

export function countActivity(activity: Activity): void {
  counts.set(activity, (counts.get(activity) ?? 0) + 1);
  lastActivity = activity;
}

function tally(): string {
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "nothing counted" : entries.map(([activity, n]) => `${activity} ${n}`).join(", ");
}

let append: ((line: string) => void) | undefined;

/**
 * Names a block of work directly instead of leaving it to a stall sample's "ran last" guess —
 * for work whose own duration is worth knowing regardless of whether it happened to line up
 * with a sample. Callers still call `countActivity` themselves for the tally.
 */
export function logSlow(activity: Activity, ms: number): void {
  if (ms >= SLOW_MS) {
    append?.(`${activity} took ${Math.round(ms)}ms`);
  }
}

/**
 * Records how long the main process's event loop is blocked and what was running when it was.
 * Writes to a file and nowhere else: the app is normally started from a shortcut, where stdout
 * goes nowhere, and a line in the console is one more thing the loop being measured has to do.
 *
 * Runs in every session rather than behind a switch: a stall is noticed while working, not while
 * looking for it, and by the time it is worth investigating the run that produced it is over.
 * A sample every 20ms is the price, and it is paid whether or not anything is being measured.
 */
export function startEventLoopMonitor(logFile: string): void {
  try {
    let size = 0;
    try {
      size = fs.statSync(logFile).size;
    } catch {
      // No log yet.
    }
    if (size >= MAX_LOG_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
    fs.appendFileSync(logFile, `# tet event loop, from ${new Date().toISOString()}\n`);
  } catch (error) {
    console.error("[tet] could not open the event loop log:", error);
    return;
  }
  append = (line: string): void => {
    fs.appendFile(logFile, `${new Date().toISOString().slice(11, 23)} ${line}\n`, () => undefined);
  };

  let expected = Date.now() + SAMPLE_MS;
  let reportAt = Date.now() + REPORT_MS;
  let stalls = 0;
  let stalledMs = 0;
  let worst = 0;
  let worstAfter: Activity | undefined;

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + SAMPLE_MS;

    if (lag >= STALL_MS) {
      stalls += 1;
      stalledMs += lag;
      if (lag > worst) {
        worst = lag;
        worstAfter = lastActivity;
      }
      if (lag >= LOUD_STALL_MS) {
        append?.(`loop blocked ${lag}ms after ${lastActivity ?? "nothing"} | ${tally()}`);
      }
    }

    if (now >= reportAt) {
      reportAt = now + REPORT_MS;
      if (stalls > 0) {
        append?.(
          `loop: ${stalls} stalls in ${REPORT_MS / 1000}s, ${stalledMs}ms lost,` +
            ` worst ${worst}ms after ${worstAfter ?? "nothing"} | ${tally()}`
        );
      }
      stalls = 0;
      stalledMs = 0;
      worst = 0;
      worstAfter = undefined;
      counts.clear();
    }
  }, SAMPLE_MS);
  // Diagnostics must not be the reason the process stays alive.
  timer.unref();
}
