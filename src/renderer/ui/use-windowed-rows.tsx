import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useElementSize } from "./use-element-size";

/** A list shorter than this draws every row, as an unwindowed one does. */
export const WINDOW_MIN_ROWS = 200;

/** `--tree-row-height` of styles.css, where the variable can't be read. */
export const TREE_ROW_HEIGHT = 24;

/** `--two-line-row-height` of styles.css, likewise. */
export const TWO_LINE_ROW_HEIGHT = 52;

/** Rows drawn beyond each edge of the scroller, so a fast scroll shows no gap before the next frame. */
const OVERSCAN = 20;

/** What the viewport is taken to be before the scroller is measured (a hidden lane measures nothing). */
const FALLBACK_VIEWPORT = 800;

/** The rows `[start, end)` a scroller `scrollTop` down and `viewport` high shows, with `overscan`
 *  more each side, for `count` rows of one `rowHeight`. */
export function windowRange(
  count: number,
  rowHeight: number,
  scrollTop: number,
  viewport: number,
  overscan = OVERSCAN,
): { start: number; end: number } {
  // A scrollTop past the end (the list just shrank) still draws the last rows.
  const first = Math.min(Math.floor(Math.max(scrollTop, 0) / rowHeight), Math.max(count - 1, 0));
  const visible = Math.ceil(viewport / rowHeight);
  return { start: Math.min(Math.max(first - overscan, 0), count), end: Math.min(first + visible + overscan, count) };
}

/** The scrollTop that brings row `index` into view with the least movement, or `scrollTop` itself
 *  where it already is. */
export function scrollTopFor(index: number, rowHeight: number, scrollTop: number, viewport: number): number {
  const top = index * rowHeight;
  if (top < scrollTop) {
    return top;
  }
  return top + rowHeight > scrollTop + viewport ? top + rowHeight - viewport : scrollTop;
}

/** A CSS length variable of `element` in px, e.g. `--tree-row-height`; `fallback` where unreadable. */
function readHeight(element: HTMLElement, variable: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(variable));
  return value > 0 ? value : fallback;
}

export interface WindowedRows {
  /** Whether the list is windowed; false draws all of it. */
  windowed: boolean;
  /** The rows to draw, `[start, end)`. */
  start: number;
  end: number;
  /** The height standing for the rows before `start` and after `end`, in px. */
  before: number;
  after: number;
  /** Scrolls row `index` into view, drawn or not. */
  scrollToRow: (index: number) => void;
}

/**
 * Draws only the rows of a long list that the scroller shows, for rows of one fixed height (`heightVariable`
 * of the scroller, e.g. `--tree-row-height`), standing in for the rest with the spacers `before` and
 * `after`. Below `WINDOW_MIN_ROWS`, or while `enabled` is false, it draws everything: a short list
 * is unchanged. The scroller holds nothing but the rows, so its scrollTop is the offset into them.
 */
export function useWindowedRows(
  scroller: RefObject<HTMLElement | null>,
  count: number,
  heightVariable: string,
  fallbackHeight: number,
  enabled = true,
): WindowedRows {
  const windowed = enabled && count > WINDOW_MIN_ROWS;
  const size = useElementSize(scroller, windowed);
  const [rowHeight, setRowHeight] = useState(fallbackHeight);
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = size?.height ?? FALLBACK_VIEWPORT;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (windowed && element) {
      setRowHeight(readHeight(element, heightVariable, fallbackHeight));
      setScrollTop(element.scrollTop);
    }
  }, [scroller, windowed, heightVariable, fallbackHeight]);

  useEffect(() => {
    const element = scroller.current;
    if (!windowed || !element) {
      return;
    }
    // Held by the row it falls in: a scroll within one row draws nothing new.
    const onScroll = (): void =>
      setScrollTop((previous) =>
        Math.floor(previous / rowHeight) === Math.floor(element.scrollTop / rowHeight) ? previous : element.scrollTop,
      );
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [scroller, windowed, rowHeight]);

  const scrollToRow = useCallback(
    (index: number): void => {
      const element = scroller.current;
      if (element) {
        element.scrollTop = scrollTopFor(index, rowHeight, element.scrollTop, element.clientHeight);
      }
    },
    [scroller, rowHeight],
  );

  if (!windowed) {
    return { windowed, start: 0, end: count, before: 0, after: 0, scrollToRow };
  }
  const { start, end } = windowRange(count, rowHeight, scrollTop, viewport);
  return { windowed, start, end, before: start * rowHeight, after: (count - end) * rowHeight, scrollToRow };
}

/** Stands in for the rows a windowed list leaves out, `height` px of them. */
export function RowSpacer({ height }: { height: number }) {
  return height > 0 ? <div style={{ height }} aria-hidden /> : null;
}
