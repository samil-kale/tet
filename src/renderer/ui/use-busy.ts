import { useCallback, useRef, useState } from "react";

/**
 * Whether something slow is underway, for a view's bar or a button's `disabled`: `run` holds
 * `busy` while `work` runs, however it ends. Counted, not flagged: of two runs that overlap, the
 * first to end must not clear the mark of the other. `initial` for what runs from the first render:
 * held from then, and taken over by the first `run`. `run` is stable.
 */
export function useBusy(initial = false): { busy: boolean; run: <T>(work: () => Promise<T>) => Promise<T> } {
  const [count, setCount] = useState(initial ? 1 : 0);
  const initialHeld = useRef(initial);
  const run = useCallback(async <T>(work: () => Promise<T>): Promise<T> => {
    if (initialHeld.current) {
      initialHeld.current = false;
    } else {
      setCount((current) => current + 1);
    }
    try {
      return await work();
    } finally {
      setCount((current) => current - 1);
    }
  }, []);
  return { busy: count > 0, run };
}
