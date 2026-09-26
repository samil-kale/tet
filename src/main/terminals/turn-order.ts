/**
 * Turn reports are ordered by when they were made (ControlRequest.at), never by arrival: by arrival
 * a turn's `busy` can overtake its own `stop`, leaving a tab finished and working.
 *
 * How far behind the last applied signal a report counts as having lost a race (two hooks of one
 * turn in flight) and is dropped. Further
 * behind, the reporter's clock jumped back (a container's, corrected after the host slept) — all of
 * a tab's reports share one clock — so it is taken, or the marks would freeze until time caught up.
 */
export const SIGNAL_STALE_MS = 30_000;

/** Whether a report still has something to say, given when the last one applied here was made. */
export function reportApplies(lastSignalAt: number | undefined, at: number): boolean {
  const behind = (lastSignalAt ?? 0) - at;
  return behind <= 0 || behind > SIGNAL_STALE_MS;
}
