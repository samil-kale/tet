import { useEffect } from "react";

/**
 * Tells main the page has drawn what the user waits for, once `ready` holds: main keeps the window
 * hidden until then. Two frames after the commit, so the paint is on screen when the window shows.
 */
export function useWindowDrawn(ready: boolean): void {
  useEffect(() => {
    if (!ready) {
      return;
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => window.tet.app.drawn());
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready]);
}
