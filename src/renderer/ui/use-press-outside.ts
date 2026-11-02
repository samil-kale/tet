import { useEffect, type RefObject } from "react";

/**
 * A press outside `box` closes what it holds, while `enabled`; a press on the status bar's button of
 * class `trigger` does not, as that button toggles it itself.
 */
export function usePressOutside(box: RefObject<HTMLElement | null>, trigger: string, onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target as Element;
      if (!box.current?.contains(target) && !target.closest(`.${trigger}`)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [box, trigger, onClose, enabled]);
}
