import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useElementSize } from "./use-element-size";

/** How near its end a list's scroller asks for more of it, in px: the Graph's distance. */
const MORE_DISTANCE = 200;

/**
 * The scroller of a list read a page at a time: `more` is called once the list's end comes within
 * `MORE_DISTANCE` of the scroller's bottom — scrolled there, or shown, grown or resized without filling
 * it, since there is nothing to scroll then. `more` is undefined while there is nothing more, or a
 * page is on its way. A hidden lane measures nothing, so it asks for nothing.
 */
export function useScrollMore(more: (() => void) | undefined): { ref: RefObject<HTMLDivElement | null>; onScroll: () => void } {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref, null);
  const ask = useCallback(() => {
    const list = ref.current;
    if (more && list && list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < MORE_DISTANCE) {
      more();
    }
  }, [more]);
  useEffect(() => ask(), [ask, size]);
  return { ref, onScroll: ask };
}
