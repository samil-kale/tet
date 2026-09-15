import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether a card dialog (`DialogFrame`) covers the window. While one does, no tab is in front: a
 * turn ending behind it keeps its mark and raises a toast. A count, since a question can stand
 * over another dialog.
 */
let covering = 0;
const listeners = new Set<() => void>();

function publish(delta: number): void {
  covering += delta;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A dialog covers the window while mounted. */
export function useCoversWindow(): void {
  useEffect(() => {
    publish(1);
    return () => publish(-1);
  }, []);
}

export function useWindowCovered(): boolean {
  return useSyncExternalStore(subscribe, () => covering > 0);
}
