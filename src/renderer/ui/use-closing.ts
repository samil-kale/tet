import { useCallback, useEffect, useState } from "react";
import { useLatest } from "./use-latest";

/** How long the notification center, a status bar list or a pane's new-tab menu takes to close; the
 *  stylesheet's transitions of their `.closing`. */
export const CLOSE_MS = 100;

/** A view fading out before it goes: `closing` from `close` on, `onClosed` once `CLOSE_MS` have passed,
 *  unless `cancel` came first. `close` and `cancel` are stable. */
export function useClosing(onClosed: () => void) {
  const [closing, setClosing] = useState(false);
  const closed = useLatest(onClosed);
  useEffect(() => {
    if (!closing) {
      return;
    }
    const timer = setTimeout(() => {
      setClosing(false);
      closed.current();
    }, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [closing, closed]);
  const close = useCallback(() => setClosing(true), []);
  const cancel = useCallback(() => setClosing(false), []);
  return { closing, close, cancel };
}
