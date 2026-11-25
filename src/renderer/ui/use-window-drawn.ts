import { useEffect } from "react";

/**
 * How long the report waits for a frame. Chromium gives a window that was never shown frames only
 * now and then, so a frame awaited there can take a second; past this the window shows without it.
 */
const FRAME_WAIT_MS = 100;

/**
 * Tells main the page has drawn what the user waits for, once `ready` holds: main keeps the window
 * hidden until then. After the frame holding the commit (its rAF, then the task after its paint),
 * so the paint is on screen when the window shows — or after `FRAME_WAIT_MS`, whichever comes first.
 */
export function useWindowDrawn(ready: boolean): void {
  useEffect(() => {
    if (!ready) {
      return;
    }
    let reported = false;
    const report = (): void => {
      if (!reported) {
        reported = true;
        window.tet.app.drawn();
      }
    };
    let afterPaint = 0;
    const frame = requestAnimationFrame(() => {
      afterPaint = window.setTimeout(report, 0);
    });
    const fallback = window.setTimeout(report, FRAME_WAIT_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(afterPaint);
      clearTimeout(fallback);
    };
  }, [ready]);
}
