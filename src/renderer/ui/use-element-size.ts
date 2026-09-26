import { useLayoutEffect, useState, type RefObject } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * `ref`'s element's size, what a divider's share multiplies (TerminalsPane's grid, EditorHost's
 * preview); null until measured.
 *
 * A layout effect seeded with a synchronous `getBoundingClientRect()`, since the observer's first
 * callback is async: a restored split is right on the first paint, not flashed wrong first. A zero
 * is an element hidden with `display: none`, not a real size, and keeps the last one. Re-seeded
 * whenever `remeasure` changes, e.g. on coming on screen: hidden it measured zero, and the
 * observer fires after the paint.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, remeasure: unknown): ElementSize | null {
  const [size, setSize] = useState<ElementSize | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const seed = element.getBoundingClientRect();
    if (seed.width > 0 && seed.height > 0) {
      setSize({ width: seed.width, height: seed.height });
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        // The same object when unchanged: the observer also fires for sizes it already reported.
        setSize((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, remeasure]);
  return size;
}
