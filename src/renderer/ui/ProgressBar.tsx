import { useLayoutEffect, useRef, useState } from "react";

/** The bit's length in pixels, the same in every pane. */
const BIT_WIDTH = 40;
/** The bit's speed in pixels per second, the same in every pane. */
const SPEED = 500;

/**
 * The one indeterminate progress bar, drawn under the header it is a child of, which declares
 * `position: relative`. See "One progress indicator per section" in AGENTS.md. Never a second one
 * under a header: a new slow reason feeds the bar it has. No spinner stands in for it, and a
 * button disabled for being underway only dims; the one spinner is a session's working mark
 * (`SessionMark`), a status rather than progress.
 *
 * Length and speed are absolute, not a share of the width, so bars of different widths side by
 * side look alike; the duration follows from the measured width. `useLayoutEffect`, so the first
 * paint has the real width rather than a duration computed for zero.
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

  // From hidden past the left edge to hidden past the right one.
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
