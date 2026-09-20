import { useSyncExternalStore } from "react";

/**
 * A value outside React that components read: the notices standing, the question up, whether a
 * dialog covers the window. Each is written by a plain function anything can call — `notify`,
 * `confirm`, `prompt` — so no view has to thread a callback for it, and every reader re-renders
 * on the change.
 *
 * `set` replaces the value; `useStore` compares by identity, as `useSyncExternalStore` does, so a
 * list or record is replaced whole rather than edited in place.
 */
export interface Store<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T): void => {
      value = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
