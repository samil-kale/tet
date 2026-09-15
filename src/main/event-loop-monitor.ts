import * as fs from "node:fs";

/** A keystroke bound for a pty waits in the same queue as this timer, so its lag is typing lag. */
const SAMPLE_MS = 20;
/** Below this, lag is scheduling noise. */
const STALL_MS = 50;
/** A stall this long gets a line of its own. */
const LOUD_STALL_MS = 200;
/** One summary per interval, only when there is something to report. */
const REPORT_MS = 60_000;
/** A measured block above this gets a line naming it. */
const SLOW_MS = 100;
/** Appended across sessions; rotated to `<file>.1` past this size. */
const MAX_LOG_BYTES = 1_000_000;

export type Activity = "output" | "input" | "reconcile" | "git" | "emit" | "startup";

const counts = new Map<Activity, number>();
/** A stall is noticed by the next sample, so what ran last is the likeliest culprit. */
let lastActivity: Activity | undefined;
/**
 * Startup phases running now, with their count (each project runs its own `list claude`). A stall
 * before any output or refresh is blamed on all of them, since projects and agents start side by
 * side — the last one entered is not necessarily the blocker.
 */
const startupPhases = new Map<string, number>();
/** For a stall after every phase has ended. */
let lastStartupPhase: string | undefined;

export function countActivity(activity: Activity): void {
  counts.set(activity, (counts.get(activity) ?? 0) + 1);
  lastActivity = activity;
}

/** Returns the function that leaves the phase. */
function enterStartup(phase: string): () => void {
  countActivity("startup");
  lastStartupPhase = phase;
  startupPhases.set(phase, (startupPhases.get(phase) ?? 0) + 1);
  return () => {
    const running = (startupPhases.get(phase) ?? 1) - 1;
    if (running > 0) {
      startupPhases.set(phase, running);
    } else {
      startupPhases.delete(phase);
    }
  };
}

/** An async startup phase, until `run`'s promise settles. Sync ones use `timeStartup`. */
export async function markStartup<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const leave = enterStartup(phase);
  try {
    return await run();
  } finally {
    leave();
  }
}

/** A sync startup phase, timed like `logSlow`. Async ones use `markStartup`. */
export function timeStartup<T>(phase: string, run: () => T): T {
  const leave = enterStartup(phase);
  const start = performance.now();
  try {
    return run();
  } finally {
    leave();
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
  if (lastActivity !== "startup") {
    return lastActivity;
  }
  if (startupPhases.size > 0) {
    return `startup:${[...startupPhases.keys()].join(", ")}`;
  }
  return `startup:${lastStartupPhase ?? "?"} (ended)`;
}

function tally(): string {
  const entries = [...counts].sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "nothing counted" : entries.map(([activity, n]) => `${activity} ${n}`).join(", ");
}

let append: ((line: string) => void) | undefined;

/** The sampler cannot see renderer work (xterm parsing, React), so the renderer reports its long
 *  tasks (Long Tasks API, main.tsx) into this log and summary. */
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

/** The renderer's `logSlow`; pre-filtered there (slow-report.ts), so ordinary renders send nothing. */
export function reportRendererSlow(label: string, ms: number): void {
  if (ms >= SLOW_MS) {
    append?.(`renderer:${label} took ${Math.round(ms)}ms`);
  }
}

/** Names a slow block instead of the "ran last" guess. Callers still call `countActivity`. */
export function logSlow(activity: Activity, ms: number): void {
  if (ms >= SLOW_MS) {
    append?.(`${activity} took ${Math.round(ms)}ms`);
  }
}

/**
 * Logs main-loop stalls and what ran before them. To a file only: `tet` starts detached, stdout
 * goes nowhere. Always on — by the time a stall matters, its run is over.
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
        // Regular, growing unexplained stalls are GC on a filling heap; only heap numbers tell.
        const { heapUsed, heapTotal } = process.memoryUsage();
        append?.(
          `loop: ${stalls} stalls in ${REPORT_MS / 1000}s, ${stalledMs}ms lost,` +
            ` worst ${worst}ms after ${worstAfter ?? "nothing"}` +
            ` | renderer: ${rendererTasks} long tasks, ${Math.round(rendererMs)}ms, worst ${Math.round(rendererWorst)}ms` +
            ` | heap ${Math.round(heapUsed / 1_048_576)}/${Math.round(heapTotal / 1_048_576)}MB` +
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
  // Diagnostics must not keep the process alive.
  timer.unref();
}
