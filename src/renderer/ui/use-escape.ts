import { useEffect, useRef } from "react";

/**
 * Closes what is over the window on Escape, caught in the capture phase and swallowed so it never
 * reaches the terminal that had focus. On `document`, so a question (`Dialog.tsx`), which listens
 * on `window` and can be asked from one of these, is not answered by the same keystroke.
 */
export function useEscape(onClose: () => void): void {
  // A ref, as in `ContextMenu`: dialogs pass inline arrows and re-render on every keystroke.
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
