/**
 * Runs `fetch` from an effect with the view's bar held (`hold`, as `PromptFields.hold`) until it
 * ends, and hands its answer to `done`. Returns the effect's cleanup: an answer landing after it is
 * dropped, and a fetch still running releases the bar then, since one that ended has released it
 * already.
 */
export function fetchHeld<T>(fetch: () => Promise<T>, hold: (held: boolean) => void, done: (result: T) => void): () => void {
  let cancelled = false;
  let fetching = true;
  hold(true);
  void fetch()
    .then((result) => {
      if (!cancelled) {
        done(result);
      }
    })
    .finally(() => {
      if (!cancelled) {
        fetching = false;
        hold(false);
      }
    });
  return () => {
    cancelled = true;
    if (fetching) {
      hold(false);
    }
  };
}
