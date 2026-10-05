import { useCallback, useEffect, useRef, useState } from "react";
import { createStore, useStore } from "./store";

/** Layout describes the window, not a repository, so it lives in renderer storage. */
const STORAGE_PREFIX = "tet.layout.";

/** A key in that storage, for what is persisted outside these hooks. */
export function layoutKey(key: string): string {
  return STORAGE_PREFIX + key;
}

/**
 * A yes or no kept outside React in the same storage — the last answer the user gave, which what
 * opens next takes as its default. Read once; `set` writes through.
 */
export function layoutFlag(key: string): { get(): boolean; set(value: boolean): void } {
  let value = localStorage.getItem(STORAGE_PREFIX + key) === "true";
  return {
    get: () => value,
    set: (next) => {
      value = next;
      localStorage.setItem(STORAGE_PREFIX + key, String(next));
    },
  };
}

/** How long after the last resize a stored size is written to storage. */
const PERSIST_MS = 300;

/**
 * Whether an area is showing, in the same layout storage. It stays as set until toggled again —
 * a lane stays out until its toggle is pressed again, one for all projects.
 */
export function useStoredToggle(key: string, initial: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(STORAGE_PREFIX + key);
    return stored === null ? initial : stored === "true";
  });
  // Stable like a setState: a fresh function per render would re-render every memoized view.
  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      localStorage.setItem(STORAGE_PREFIX + key, String(next));
    },
    [key],
  );
  return [open, set];
}

/**
 * Which of `choices` an area shows, in the same layout storage, kept as `useStoredToggle` keeps
 * whether it is out. Anything stored outside `choices` is `initial`.
 */
export function useStoredChoice<T extends string>(key: string, choices: readonly T[], initial: T): [T, (choice: T) => void] {
  const [choice, setChoice] = useState<T>(() => {
    const stored = localStorage.getItem(STORAGE_PREFIX + key);
    return choices.find((candidate) => candidate === stored) ?? initial;
  });
  // Stable like a setState, as `useStoredToggle`'s.
  const set = useCallback(
    (next: T) => {
      setChoice(next);
      localStorage.setItem(STORAGE_PREFIX + key, next);
    },
    [key],
  );
  return [choice, set];
}

/**
 * Which groups of a tree the user has collapsed, restored on the next start, in layout storage.
 * `initial` names what starts collapsed; a key never toggled stands expanded.
 */
export function useCollapsedGroups(key: string, initial: string[]): [(group: string) => boolean, (group: string) => void] {
  const storageKey = STORAGE_PREFIX + key;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) {
        return JSON.parse(stored) as Record<string, boolean>;
      }
    } catch {
      // Unreadable storage is the initial state.
    }
    return Object.fromEntries(initial.map((group) => [group, true]));
  });
  const isCollapsed = useCallback((group: string) => collapsed[group] ?? false, [collapsed]);
  const toggle = useCallback(
    (group: string) => {
      const next = { ...collapsed, [group]: !(collapsed[group] ?? false) };
      setCollapsed(next);
      localStorage.setItem(storageKey, JSON.stringify(next));
    },
    [collapsed, storageKey],
  );
  return [isCollapsed, toggle];
}

/**
 * A number the user sets by dragging, restored on the next start. `restore` maps what storage
 * holds (`NaN` when nothing) to the start value. Written once the drag settles, not per move: the
 * write is synchronous and a drag delivers 60+ values a second. A write pending on unmount is
 * dropped.
 */
function usePersistedNumber(storageKey: string, restore: (stored: number) => number): [number, (next: number) => void] {
  const [value, setValue] = useState(() => restore(Number(localStorage.getItem(storageKey))));
  const persist = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const set = useCallback(
    (next: number) => {
      setValue(next);
      clearTimeout(persist.current);
      persist.current = setTimeout(() => localStorage.setItem(storageKey, String(next)), PERSIST_MS);
    },
    [storageKey],
  );
  useEffect(() => () => clearTimeout(persist.current), []);
  return [value, set];
}

/**
 * A size the user can drag. The floor applies to the restored size too, which would otherwise
 * disagree with the area's own `min-*` until the sash is grabbed.
 */
export function useStoredSize(key: string, initial: number, min: number): [number, (size: number) => void] {
  return usePersistedNumber(STORAGE_PREFIX + key, (stored) => Math.max(min, Number.isFinite(stored) && stored > 0 ? stored : initial));
}

/** What storage holds as a share, `initial` when outside (0, 1) — see `usePersistedShare`. */
function restoredShare(stored: number, initial: number): number {
  return Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : initial;
}

/** One value per storage key, read by every mounted `usePersistedShare` of it, and its pending
 *  write. */
const shares = new Map<string, ReturnType<typeof createStore<number>>>();
const sharePersists = new Map<string, ReturnType<typeof setTimeout>>();

function storedShare(storageKey: string, initial: number): ReturnType<typeof createStore<number>> {
  let store = shares.get(storageKey);
  if (!store) {
    store = createStore(restoredShare(Number(localStorage.getItem(storageKey)), initial));
    shares.set(storageKey, store);
  }
  return store;
}

/**
 * An area's *share* of its container, restored on the next start — `initial` until dragged. A share,
 * not pixels, so it holds at any container size; the owner multiplies it by a live measurement and
 * turns `Sash`'s pixels back into one. Anything outside (0, 1) is ignored both ways: read, since
 * the user can edit it, and written, since a container too small for two areas has no share.
 *
 * One value for every view using the key at once (each editor tab's preview): a drag in one resizes
 * them all. The write waits for the drag to settle, as `useStoredSize`'s does; one pending when a view
 * unmounts is kept, and the others show it.
 */
export function usePersistedShare(storageKey: string, initial: number): [number, (share: number) => void] {
  const share = useStore(storedShare(storageKey, initial));
  const set = useCallback(
    (next: number) => {
      if (next > 0 && next < 1) {
        storedShare(storageKey, initial).set(next);
        clearTimeout(sharePersists.get(storageKey));
        sharePersists.set(
          storageKey,
          setTimeout(() => localStorage.setItem(storageKey, String(next)), PERSIST_MS),
        );
      }
    },
    [storageKey, initial],
  );
  return [share, set];
}

/** `usePersistedShare` under a fixed layout key, like `useStoredSize`. */
export function useStoredShare(key: string, initial: number): [number, (share: number) => void] {
  return usePersistedShare(STORAGE_PREFIX + key, initial);
}
