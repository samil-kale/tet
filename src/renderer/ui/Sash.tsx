import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

/** Layout describes the window, not a repository, so it lives in renderer storage. */
const STORAGE_PREFIX = "tet.layout.";
/** How long after the last resize a pane size is written to storage. */
const PERSIST_MS = 300;

/**
 * The floor every pane shares, one per direction: a section header (35px) plus three 28px rows
 * high, and as wide as such a header needs with its actions. Kept in step with `styles.css`'s
 * `--pane-min-width`/`--pane-min-height`: a sash bounds only a drag, a shrinking window bypasses it.
 */
export const MIN_PANE_WIDTH = 180;
export const MIN_PANE_HEIGHT = 120;
/** The floor for the terminals, the one pane no sash sizes directly. */
export const MIN_CONTENT_WIDTH = 320;

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
export function usePersistedNumber(storageKey: string, restore: (stored: number) => number): [number, (next: number) => void] {
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

interface SashProps {
  /** A vertical sash is dragged left and right, a horizontal one up and down. */
  orientation: "vertical" | "horizontal";
  /** Current size of the pane it resizes. */
  size: number;
  /** How small that pane may be dragged, in pixels. */
  min: number;
  /** How much of the container must be left for the pane on the other side. */
  minOther: number;
  /** Sizes the pane *behind* it rather than in front — the commands list's case. */
  reverse?: boolean;
  onResize: (size: number) => void;
}

/**
 * The draggable divider between two panes. It sizes the pane in front of it and the rest of the
 * container absorbs the difference, so only one side carries a size.
 */
export function Sash({ orientation, size, min, minOther, reverse, onResize }: SashProps) {
  const vertical = orientation === "vertical";
  const drag = useRef<{ origin: number; size: number; total: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  /** The size the next frame reports, and that frame's handle while scheduled. */
  const pending = useRef<number | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);

  const begin = (event: PointerEvent<HTMLDivElement>): void => {
    const container = event.currentTarget.parentElement;
    if (event.button !== 0 || !container) {
      return;
    }
    // Pointer capture keeps moves coming over a terminal, the diff or outside the window, with no
    // document-level listeners.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      origin: vertical ? event.clientX : event.clientY,
      size,
      // Negative margins take the sash out of the layout, so the container's size is what the two
      // panes share. Measured once per drag: it cannot change during one.
      total: vertical ? container.clientWidth : container.clientHeight
    };
    setDragging(true);
  };

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (!start) {
      return;
    }
    // Clamped here, not only in the layout, so dragging back from an edge responds at once
    // instead of first working off an unseen overshoot.
    const moved = (vertical ? event.clientX : event.clientY) - start.origin;
    const next = reverse ? start.size - moved : start.size + moved;
    pending.current = Math.round(Math.max(min, Math.min(next, start.total - minOther)));
    // One resize per frame, not per pointer event (hundreds a second). The last position wins;
    // `end` flushes what no frame has taken yet.
    frame.current ??= requestAnimationFrame(flush);
  };

  const flush = (): void => {
    frame.current = undefined;
    if (pending.current !== undefined) {
      onResize(pending.current);
      pending.current = undefined;
    }
  };

  const end = (): void => {
    drag.current = undefined;
    if (frame.current !== undefined) {
      cancelAnimationFrame(frame.current);
    }
    flush();
    setDragging(false);
  };

  return (
    <div
      className={`sash ${orientation}${dragging ? " dragging" : ""}`}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
