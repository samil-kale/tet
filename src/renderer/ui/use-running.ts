import { useCallback, useState } from "react";

/**
 * Whether something slow is underway, for a view's bar or a button's `disabled`: `run` holds
 * `running` while `work` runs, however it ends. `initial` for what runs from the first render.
 * `run` is stable.
 */
export function useRunning(initial = false): { running: boolean; run: <T>(work: () => Promise<T>) => Promise<T> } {
  const [running, setRunning] = useState(initial);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    setRunning(true);
    try {
      return await work();
    } finally {
      setRunning(false);
    }
  }, []);
  return { running, run };
}
