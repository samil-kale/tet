import { useEffect, useRef } from "react";

/**
 * Closes whatever is over the window when Escape is pressed. Listened for in the capture phase
 * and swallowed, so closing it can't double as an ESC keystroke for the terminal that had focus
 * before it opened. On `document`, which is why a question (`Dialog.tsx`) listens on `window`
 * instead: it can be asked from one of these, and one keystroke must not answer both.
 */
export function useEscape(onClose: () => void): void {
  // In a ref, as `ContextMenu` holds its `onClose`: a dialog may pass an inline arrow, and a
  // dialog re-renders on every keystroke in its fields.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onCapture = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
    };
    document.addEventListener("keydown", onCapture, true);
    return () => document.removeEventListener("keydown", onCapture, true);
  }, []);
}
