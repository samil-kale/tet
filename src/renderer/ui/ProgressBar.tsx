import { useLayoutEffect, useRef, useState } from "react";

/** How long the bit is, in pixels — the same in a narrow sidebar section and a wide pane. */
const BIT_WIDTH = 40;
/** How fast it travels, in pixels per second — likewise the same everywhere. */
const SPEED = 500;

/**
 * The one indeterminate progress bar, drawn under whichever header or bar it is a child of; each
 * declares `position: relative`, which is all it takes. See "One progress indicator per pane" in
 * CLAUDE.md.
 *
 * The bit's length and speed are absolute, not a share of the bar's width: a percentage-sized
 * bit reads wrong the moment two bars of different widths sit side by side, a 300px pane's worm
 * a third the length of a 900px pane's and crawling at a third the speed. The width is measured
 * and the run's duration follows from it. `useLayoutEffect`, not `useEffect`: the first paint has
 * to have the real width, or the bit sets off for one frame with a duration computed for zero.
 */
export function ProgressBar() {
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) {
      return;
    }
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // From fully hidden past the left edge to fully hidden past the right one.
  const travel = width + BIT_WIDTH;
  return (
    <div className="progress-bar" ref={bar}>
      <div
        className="progress-bar-bit"
        style={
          {
            width: BIT_WIDTH,
            left: -BIT_WIDTH,
            "--travel": `${travel}px`,
            animationDuration: `${travel / SPEED}s`
          } as React.CSSProperties
        }
      />
    </div>
  );
}
