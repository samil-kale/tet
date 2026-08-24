import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

/**
 * Where a dragged pane size is kept. Layout describes the window rather than any one
 * repository, so it lives in the renderer's own storage instead of the project store, and
 * every project sees the same one.
 */
const STORAGE_PREFIX = "tet.layout.";
/** How long after the last resize a pane size is written to storage. */
const PERSIST_MS = 300;

/**
 * The floor every pane shares, per direction. A pane here is either a column beside the
 * terminals or one of two sections stacked inside such a column, and each kind is dragged the
 * same way — so this is one number per direction rather than one per view, the way the 35px
 * bar and the 22px action button are.
 *
 * The height is a section header (35px) and three of the 28px rows under it, which is the
 * least that still reads as a list rather than a strip. The width is what such a header needs
 * with its actions beside it. `styles.css` states both again as `--pane-min-width` and
 * `--pane-min-height`, and they have to stay in step: a sash only bounds a *drag*, while a
 * window being made smaller reaches the same panes without going through one.
 */
export const MIN_PANE_WIDTH = 180;
export const MIN_PANE_HEIGHT = 120;
/** What is left over for the terminals — the one pane no sash sizes directly. */
export const MIN_CONTENT_WIDTH = 320;

/** Whether a pane is showing at all — the same storage, since it is the same kind of choice. */
export function usePaneToggle(key: string, initial: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(STORAGE_PREFIX + key);
    return stored === null ? initial : stored === "true";
  });
  // Stable, like a setState: it is passed down as a prop, and a fresh function per render
  // would re-render every memoized view that takes it.
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
 * A number the user sets by dragging, restored on the next start — a pane size here, a
 * divider's share in the terminal split (`useDividerFraction`). `restore` turns what storage
 * holds (`NaN` when nothing) into the value to start from. Written once the drag has settled
 * rather than per pointer move: the write is synchronous, and a drag delivers a value per move —
 * sixty and more a second. A write still pending on unmount is dropped. The setter is stable for
 * the same reason as the toggle's above.
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
 * A pane size the user can drag. The floor applies to what comes back as well, not only to the
 * drag: a size stored before that floor existed would otherwise disagree with the pane's own
 * `min-*` until somebody grabbed the sash.
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
  /** How much of the container has to be left over for the pane on the other side. */
  minOther: number;
  /**
   * The pane it sizes is the one *behind* it, not in front — dragging towards it makes it
   * smaller. What the commands list needs, since it is the bottom one that keeps its height.
   */
  reverse?: boolean;
  onResize: (size: number) => void;
  /**
   * Drawn the way `dragging` below draws it, but driven from outside: the terminal split uses
   * this while a tab is dragged across the grid, so the seam between panes reads as part of the
   * same drop target they are, not a dead gap between two highlighted ones.
   */
  highlighted?: boolean;
}

/**
 * The draggable divider between two panes, VS Code's "sash". It sizes the pane in front of it
 * and lets the rest of the container absorb the difference, so of the two sides only one ever
 * carries a size of its own.
 */
export function Sash({ orientation, size, min, minOther, reverse, onResize, highlighted }: SashProps) {
  const vertical = orientation === "vertical";
  const drag = useRef<{ origin: number; size: number; total: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  /** The size the next frame will report, and that frame's handle while one is scheduled. */
  const pending = useRef<number | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);

  const begin = (event: PointerEvent<HTMLDivElement>): void => {
    const container = event.currentTarget.parentElement;
    if (event.button !== 0 || !container) {
      return;
    }
    // Capturing the pointer keeps the moves coming while it is over a terminal, over the diff,
    // or outside the window entirely — no document-level listeners to install and remove.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      origin: vertical ? event.clientX : event.clientY,
      size,
      // Negative margins pull the sash out of the layout, so the container's own size is what
      // the two panes have to share. Measured once per drag: it cannot change during one.
      total: vertical ? container.clientWidth : container.clientHeight
    };
    setDragging(true);
  };

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (!start) {
      return;
    }
    // Clamped here rather than only in the layout, so dragging back from an edge responds at
    // once instead of first working off an overshoot the user never saw.
    const moved = (vertical ? event.clientX : event.clientY) - start.origin;
    const next = reverse ? start.size - moved : start.size + moved;
    pending.current = Math.round(Math.max(min, Math.min(next, start.total - minOther)));
    // One resize per frame, not per pointer event: a mouse reports several hundred moves a
    // second, each of which was a render of everything the size reaches, and nothing between
    // two paints can be seen anyway. The last position always wins — the frame reads it when
    // it comes, and `end` flushes what a frame has not yet taken.
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
      className={`sash ${orientation}${dragging ? " dragging" : ""}${highlighted ? " highlighted" : ""}`}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
