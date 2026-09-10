/**
 * How far behind the last applied signal a report may be and still count as one that simply lost
 * a race. Two hooks of one turn can be in flight together — ~100 ms out of a sandbox, a second on
 * a loaded host — and the older one has nothing left to say. Beyond this window it is not a race
 * at all but a clock that moved: every report about one tab comes from that tab's own agent, so
 * the only way a report can be *much* older than the last is the reporter's own clock jumping
 * backwards (a container's, corrected after the host slept). Dropping those would freeze the
 * tab's marks until real time caught up, so they are taken and the tab follows the new clock.
 */
export const SIGNAL_STALE_MS = 30_000;

/** Whether a report still has something to say, given when the last one applied here was made. */
export function reportApplies(lastSignalAt: number | undefined, at: number): boolean {
  const behind = (lastSignalAt ?? 0) - at;
  return behind <= 0 || behind > SIGNAL_STALE_MS;
}
