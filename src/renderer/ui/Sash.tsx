import { useRef, useState, type PointerEvent } from "react";

/**
 * The floor every pane shares, one per direction: a section header (35px) plus three 28px rows
 * high, and as wide as the widest such header needs with its actions — the Explorer's four. Kept in
 * step with `styles.css`'s `--pane-min-width`/`--pane-min-height`: a sash bounds only a drag, a
 * shrinking window bypasses it.
 */
export const MIN_PANE_WIDTH = 230;
export const MIN_PANE_HEIGHT = 120;
/** The floor for the terminals, the one pane no sash sizes directly. */
export const MIN_CONTENT_WIDTH = 320;

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
