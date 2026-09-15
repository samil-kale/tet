/** event-loop-monitor.ts's SLOW_MS, checked here too so an ordinary render costs no message. */
const SLOW_MS = 100;

/** A named renderer block into event-loop.log, when it ran long. */
export function reportSlow(label: string, ms: number): void {
  if (ms >= SLOW_MS) {
    window.tet.app.reportSlow(label, ms);
  }
}
