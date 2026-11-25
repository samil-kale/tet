import { useEffect } from "react";

/**
 * Tells main the page has drawn what the user waits for, once `ready` holds: main keeps the window
 * hidden until then. Right after the commit, not after a frame: Chromium paints a window that was
 * never shown only once it shows, so a frame awaited before that arrives late or never.
 */
export function useWindowDrawn(ready: boolean): void {
  useEffect(() => {
    if (ready) {
      window.tet.app.drawn();
    }
  }, [ready]);
}
