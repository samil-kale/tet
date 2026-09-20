import { useEffect } from "react";
import { createStore, useStore } from "./store";

/**
 * Whether a card dialog (`DialogFrame`) covers the window. While one does, no tab is in front: a
 * turn ending behind it keeps its mark and raises a toast. A count, since a question can stand
 * over another dialog.
 */
const covering = createStore(0);

/** A dialog covers the window while mounted. */
export function useCoversWindow(): void {
  useEffect(() => {
    covering.set(covering.get() + 1);
    return () => covering.set(covering.get() - 1);
  }, []);
}

export function useWindowCovered(): boolean {
  return useStore(covering) > 0;
}
