/** The main process's SLOW_MS (event-loop-monitor.ts), checked here as well so an ordinary render
 *  or fit costs no message. */
const SLOW_MS = 100;

/** A named block of the renderer's own work, into event-loop.log once it ran long. */
export function reportSlow(label: string, ms: number): void {
  if (ms >= SLOW_MS) {
    window.tet.app.reportSlow(label, ms);
  }
}
