import { useEffect, useRef } from "react";

/** Who closes on Escape, the last to open last: an agent's credential dialog can open over the
 *  Settings, and one keystroke must not close both. */
const closers: { current: () => void }[] = [];

function onCapture(event: KeyboardEvent): void {
  const top = closers.at(-1);
  if (event.key === "Escape" && top) {
    event.preventDefault();
    event.stopPropagation();
    top.current();
  }
}

/** Puts `close` on top of the Escape stack until the returned release. */
export function holdEscape(close: { current: () => void }): () => void {
  if (closers.length === 0) {
    document.addEventListener("keydown", onCapture, true);
  }
  closers.push(close);
  return () => {
    closers.splice(closers.indexOf(close), 1);
    if (closers.length === 0) {
      document.removeEventListener("keydown", onCapture, true);
    }
  };
}

/**
 * Closes what is over the window on Escape, caught in the capture phase and swallowed so it never
 * reaches the terminal that had focus. On `document`, so a question (`Dialog.tsx`), which listens
 * on `window` and can be asked from one of these, is not answered by the same keystroke. Only the
 * last one opened, which is also the one drawn on top.
 */
export function useEscape(onClose: () => void): void {
  // A ref, as in `ContextMenu`: dialogs pass inline arrows and re-render on every keystroke.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => holdEscape(close), []);
}
