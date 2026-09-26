import { useEffect, type RefObject } from "react";
import { createStore, useStore } from "./store";

/**
 * The card dialogs (`DialogFrame`) covering the window, the last opened on top. While one does, no
 * tab is in front: a turn ending behind it keeps its mark and raises a toast. A list, since a
 * question can stand over another dialog.
 */
const covering = createStore<readonly HTMLDialogElement[]>([]);

/** A dialog covers the window while mounted. */
export function useCoversWindow(dialog: RefObject<HTMLDialogElement | null>): void {
  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    covering.set([...covering.get(), element]);
    return () => covering.set(covering.get().filter((entry) => entry !== element));
  }, [dialog]);
}

/** For a listener outside React. */
export function isWindowCovered(): boolean {
  return covering.get().length > 0;
}

export function useWindowCovered(): boolean {
  return useStore(covering).length > 0;
}

/** The dialog on top: a modal dialog leaves the rest of the window inert and under its dim, so
 *  what must stay live over it is drawn inside it (`Notices`). */
export function useTopDialog(): HTMLDialogElement | undefined {
  return useStore(covering).at(-1);
}
