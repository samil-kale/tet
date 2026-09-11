import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether a dialog covers the window — a card dialog (`DialogFrame`) or the diff dialog. While one
 * does, no tab is in front of the user: a turn ending behind it keeps its mark and raises a toast.
 * A count, not a flag: a question can stand over the diff dialog.
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

/** Called by a dialog: it covers the window for as long as it is mounted. */
export function useCoversWindow(): void {
  useEffect(() => {
    publish(1);
    return () => publish(-1);
  }, []);
}

export function useWindowCovered(): boolean {
  return useSyncExternalStore(subscribe, () => covering > 0);
}
