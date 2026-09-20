import { useCallback, useEffect, useRef, useState } from "react";

/** Layout describes the window, not a repository, so it lives in renderer storage. */
const STORAGE_PREFIX = "tet.layout.";
/** How long after the last resize a pane size is written to storage. */
const PERSIST_MS = 300;

/**
 * Whether a pane is showing, in the same layout storage. It stays as set until toggled again —
 * the side pane stays out until its view's toggle is pressed again, one for all projects.
 */
export function usePaneToggle(key: string, initial: boolean): [boolean, (open: boolean) => void] {
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
    [key]
  );
  return [open, set];
}

/**
 * Which sections of a tree the user has folded, restored on the next start, in layout storage.
 * `initial` names what starts folded; a key never toggled stands open.
 */
export function useCollapsedSections(key: string, initial: string[]): [(section: string) => boolean, (section: string) => void] {
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
    return Object.fromEntries(initial.map((section) => [section, true]));
  });
  const isCollapsed = useCallback((section: string) => collapsed[section] ?? false, [collapsed]);
  const toggle = useCallback(
    (section: string) => {
      const next = { ...collapsed, [section]: !(collapsed[section] ?? false) };
      setCollapsed(next);
      localStorage.setItem(storageKey, JSON.stringify(next));
    },
    [collapsed, storageKey]
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
    [storageKey]
  );
  useEffect(() => () => clearTimeout(persist.current), []);
  return [value, set];
}

/**
 * A pane size the user can drag. The floor applies to the restored size too, which would otherwise
 * disagree with the pane's own `min-*` until the sash is grabbed.
 */
export function usePaneSize(key: string, initial: number, min: number): [number, (size: number) => void] {
  return usePersistedNumber(STORAGE_PREFIX + key, (stored) =>
    Math.max(min, Number.isFinite(stored) && stored > 0 ? stored : initial)
  );
}

/**
 * A pane's *share* of its container, restored on the next start — `initial` until dragged. A share,
 * not pixels, so it holds at any container size; the owner multiplies it by a live measurement and
 * turns `Sash`'s pixels back into one. Anything outside (0, 1) is ignored both ways: read, since
 * the user can edit it, and written, since a container too small for two panes has no share.
 */
export function usePersistedShare(storageKey: string, initial: number): [number, (share: number) => void] {
  const [share, setShare] = usePersistedNumber(storageKey, (stored) =>
    Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : initial
  );
  const set = useCallback(
    (next: number) => {
      if (next > 0 && next < 1) {
        setShare(next);
      }
    },
    [setShare]
  );
  return [share, set];
}

/** `usePersistedShare` under a fixed layout key, like `usePaneSize`. */
export function usePaneShare(key: string, initial: number): [number, (share: number) => void] {
  return usePersistedShare(STORAGE_PREFIX + key, initial);
}
