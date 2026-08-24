import { useEffect, useRef } from "react";

export interface UseEscapeOptions {
  /**
   * A selector for an element (like monaco's editor root) that handles its own Escape first —
   * closing the find widget, clearing a selection — before a bare Escape should close the
   * dialog around it. Without this, the capture-phase listener below would close the dialog on
   * the very Escape the editor needed for its own widget.
   */
  deferWithin?: string;
}

/**
 * Closes whatever is over the window when Escape is pressed. Listened for in the capture phase
 * and swallowed, so closing it can't double as an ESC keystroke for the terminal that had focus
 * before it opened. On `document`, which is why a question (`Dialog.tsx`) listens on `window`
 * instead: it can be asked from one of these, and one keystroke must not answer both.
 *
 * With `deferWithin`, the capture-phase listener steps aside for a keystroke inside that element
 * and a second, bubble-phase listener takes over — closing only if the element itself left the
 * key unhandled (`!event.defaultPrevented`), the same "Escape peels one layer" monaco already
 * gives its find widget, a selection or a suggestion list.
 */
export function useEscape(onClose: () => void, options?: UseEscapeOptions): void {
  const deferWithin = options?.deferWithin;
  // In a ref, as `ContextMenu` holds its `onClose`: a dialog may pass an inline arrow, and the
  // diff dialog re-renders on every diff load and keystroke — not a reason to swap two
  // document listeners each time.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onClose = (): void => close.current();
    const isDeferred = (event: KeyboardEvent): boolean =>
      deferWithin !== undefined && event.target instanceof Element && event.target.closest(deferWithin) !== null;

    const onCapture = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !isDeferred(event)) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onCapture, true);
    if (deferWithin === undefined) {
      return () => document.removeEventListener("keydown", onCapture, true);
    }

    const onBubble = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented && isDeferred(event)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onBubble);
    return () => {
      document.removeEventListener("keydown", onCapture, true);
      document.removeEventListener("keydown", onBubble);
    };
  }, [deferWithin]);
}
