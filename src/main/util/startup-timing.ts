import { appendLog } from "./error-log";

/** Every start's steps, written to errors.log once the window shows: each step's name and its time
 *  since the process started (performance.now's origin). */
const marks: { name: string; at: number }[] = [];
let reported = false;

/**
 * Notes that a step of the start was reached; only the first start counts, so a re-check or a
 * reloaded page after the report adds nothing.
 */
export function markStartup(name: string): void {
  if (!reported) {
    marks.push({ name, at: performance.now() });
  }
}

/** Writes the marks, in the order they were reached, as one entry; once. */
export function reportStartup(): void {
  if (reported) {
    return;
  }
  markStartup("window shown");
  reported = true;
  const lines = marks.map(({ name, at }) => `${Math.round(at).toString().padStart(7)} ms  ${name}`);
  appendLog(`[TET] startup timing, since the process started ${new Date().toISOString()}\n${lines.join("\n")}\n`);
}
