import * as fs from "node:fs";

/** How often the loop is sampled. A keystroke on its way to a pty waits in the same queue as this
 *  timer, so how late the timer runs is how late the keystroke would be. */
const SAMPLE_MS = 20;
/** Below this, a late sample is scheduling noise rather than something a typist could feel. */
const STALL_MS = 50;
/** A stall this long is worth a line of its own, not just a tally. */
const LOUD_STALL_MS = 200;
/** One summary per interval, and only when there was something to report. */
const REPORT_MS = 60_000;
/** Below this a single measured block is scheduling noise; above it, worth a line naming the block
 *  itself rather than leaving it to the "ran last" guess. */
const SLOW_MS = 100;
/** The log is appended across sessions, so a stall can be looked up days later; past this size it
 *  is rotated to `<file>.1`, so at most two files of this size ever exist. */
const MAX_LOG_BYTES = 1_000_000;

/** The main process's continuous work, in the places it happens. */
export type Activity = "output" | "input" | "reconcile" | "git" | "emit" | "startup";

const counts = new Map<Activity, number>();
/** What ran last. A stall is only noticed by the sample that follows it, so whatever was running
 *  just before is the likeliest thing to have blocked it. */
let lastActivity: Activity | undefined;
/**
 * Which stretch of "startup" ran last: the one activity that is a sequence of different things,
 * each run once and none of them counted elsewhere — so a stall before the first output or
 * refresh, which the tally alone can only call "nothing", is put to the stretch it fell in.
 */
let startupPhase: string | undefined;

export function countActivity(activity: Activity): void {
  counts.set(activity, (counts.get(activity) ?? 0) + 1);
  lastActivity = activity;
}

/** Enters a stretch of startup — what a stall from here on is attributed to, until the next. */
export function markStartup(phase: string): void {
  countActivity("startup");
  startupPhase = phase;
}

/** A stretch of startup that runs synchronously, timed as `logSlow` times a block; returns what
 *  `run` returns. For the async ones, `markStartup` alone. */
export function timeStartup<T>(phase: string, run: () => T): T {
  markStartup(phase);
  const start = performance.now();
  try {
    return run();
  } finally {
    const ms = performance.now() - start;
    if (ms >= SLOW_MS) {
      append?.(`startup:${phase} took ${Math.round(ms)}ms`);
    }
  }
}

function lastLabel(): string {
  if (lastActivity === undefined) {
    return "nothing";
  }
  return lastActivity === "startup" && startupPhase ? `startup:${startupPhase}` : lastActivity;
}

function tally(): string {
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "nothing counted" : entries.map(([activity, n]) => `${activity} ${n}`).join(", ");
}

let append: ((line: string) => void) | undefined;

/** The renderer's half of the same question: the sampler above cannot see xterm parsing a busy
 *  TUI's repaint or React re-rendering the git pane, so the renderer reports its own long tasks
 *  (Chromium's Long Tasks API, main.tsx) into this log and the same summary. */
let rendererTasks = 0;
let rendererMs = 0;
let rendererWorst = 0;

export function reportRendererTask(ms: number, context: string): void {
  rendererTasks += 1;
  rendererMs += ms;
  rendererWorst = Math.max(rendererWorst, ms);
  if (ms >= LOUD_STALL_MS) {
    append?.(`renderer blocked ${Math.round(ms)}ms (${context}) | ${tally()}`);
  }
}

/** Names a block of work directly instead of leaving it to a stall sample's "ran last" guess.
 *  Callers still call `countActivity` themselves for the tally. */
export function logSlow(activity: Activity, ms: number): void {
  if (ms >= SLOW_MS) {
    append?.(`${activity} took ${Math.round(ms)}ms`);
  }
}

/**
 * Records how long the main process's event loop is blocked and what was running when it was.
 * Writes to a file and nowhere else: the app is normally started from a shortcut, where stdout
 * goes nowhere. Runs in every session rather than behind a switch — by the time a stall is worth
 * investigating, the run that produced it is over. A sample every 20ms is the price.
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
  let worstAfter: string | undefined;

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + SAMPLE_MS;

    if (lag >= STALL_MS) {
      stalls += 1;
      stalledMs += lag;
      if (lag > worst) {
        worst = lag;
        worstAfter = lastLabel();
      }
      if (lag >= LOUD_STALL_MS) {
        append?.(`loop blocked ${lag}ms after ${lastLabel()} | ${tally()}`);
      }
    }

    if (now >= reportAt) {
      reportAt = now + REPORT_MS;
      if (stalls > 0 || rendererTasks > 0) {
        append?.(
          `loop: ${stalls} stalls in ${REPORT_MS / 1000}s, ${stalledMs}ms lost,` +
            ` worst ${worst}ms after ${worstAfter ?? "nothing"}` +
            ` | renderer: ${rendererTasks} long tasks, ${Math.round(rendererMs)}ms, worst ${Math.round(rendererWorst)}ms` +
            ` | ${tally()}`
        );
      }
      stalls = 0;
      stalledMs = 0;
      worst = 0;
      worstAfter = undefined;
      rendererTasks = 0;
      rendererMs = 0;
      rendererWorst = 0;
      counts.clear();
    }
  }, SAMPLE_MS);
  // Diagnostics must not be the reason the process stays alive.
  timer.unref();
}
