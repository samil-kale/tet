import { useState, type DragEvent, type HTMLAttributes } from "react";

/**
 * Reordering a list's rows by dragging, the one way both sidebar lists do it — the projects and
 * the saved commands. It was the same seventy lines in each, pointing at each other with "see
 * the other one for why", and the two must not drift apart: the CSS that draws the drop line is
 * already declared once for both.
 *
 * What stays with each list is only what differs: its own drag type (a row dragged across a
 * terminal must not end up pasted into it, and no other list may take the drop), what a row's
 * drag carries (an id where rows have one, the position where the same entry can be in the
 * list twice), and what to do with the finished move.
 */
export interface DragReorderOptions {
  /** A MIME type of this list's own, e.g. "application/x-tet-project". */
  dragType: string;
  /** How many rows there are; the index one past the last stands for the end of the list. */
  count: number;
  /** What the drag carries for the row at `index`. */
  payloadOf: (index: number) => string;
  /** The row that payload names *now*, or -1 when it is gone — a drop resolves at drop time. */
  indexOf: (payload: string) => number;
  /** A finished move: the row at `from` goes to insertion index `to`. See `reorder`. */
  onMove: (from: number, to: number) => void;
}

type RowElement = HTMLDivElement;

export interface DragReorder {
  /** Spread onto each row, with its index. */
  rowProps: (index: number) => HTMLAttributes<RowElement> & { draggable: true };
  /** Spread onto the rows' container: the empty space below the last row is "the end". */
  listProps: HTMLAttributes<RowElement>;
  /** The row's drag classes — "dragging", "drop-above", "drop-below" — for its class list. */
  rowClasses: (index: number) => string[];
}

/** The list with the row at `from` moved to insertion index `to`. */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  const moved = items.filter((_, position) => position !== from);
  // Everything behind the row moves up once it is out of the list, so a target past it is one
  // index closer than it looked.
  moved.splice(to > from ? to - 1 : to, 0, items[from]);
  return moved;
}

export function useDragReorder({ dragType, count, payloadOf, indexOf, onMove }: DragReorderOptions): DragReorder {
  const [dragged, setDragged] = useState<number | null>(null);
  /** Where the dragged row would land: the insertion index it would take among the others. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  /**
   * The insertion index, from the pointer's position over one row: past its middle it belongs
   * below it, which is the next index. Both the line on screen and the drop itself go through
   * this, so the two cannot disagree.
   */
  const insertionIndex = (event: DragEvent<RowElement>, index: number): number => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? index : index + 1;
  };

  const end = (): void => {
    setDragged(null);
    setDropAt(null);
  };

  const move = (payload: string, to: number): void => {
    end();
    const from = indexOf(payload);
    // NaN and -1 both fail this, so a drop that carries nothing resolvable moves nothing.
    if (from >= 0 && from < count) {
      onMove(from, to);
    }
  };

  const rowProps = (index: number): HTMLAttributes<RowElement> & { draggable: true } => ({
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.setData(dragType, payloadOf(index));
      event.dataTransfer.effectAllowed = "move";
      setDragged(index);
    },
    onDragOver: (event) => {
      // What is being dragged is read off the drag itself rather than off our own state: it
      // is also what tells a row apart from a file dragged in from outside, which no list is
      // a target for.
      if (!event.dataTransfer.types.includes(dragType)) {
        return;
      }
      // Only a prevented dragover makes an element a drop target at all.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropAt(insertionIndex(event, index));
    },
    onDrop: (event) => {
      event.preventDefault();
      // Straight from the event, not from the state the last dragover set: that state exists
      // to draw the line, and a drop must not depend on the render for it having landed yet.
      move(event.dataTransfer.getData(dragType), insertionIndex(event, index));
    },
    onDragEnd: end
  });

  /**
   * The empty space below the last row, standing for the end of the list. Without it the only
   * way to drop a row last would be the lower half of the last one, a strip a few pixels tall.
   * Bubbling brings the rows' own drags here too, so anything that landed on a row is left to
   * the row.
   */
  const isBelowList = (event: DragEvent<RowElement>): boolean => event.target === event.currentTarget;

  const listProps: HTMLAttributes<RowElement> = {
    onDragOver: (event) => {
      if (!isBelowList(event) || !event.dataTransfer.types.includes(dragType)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropAt(count);
    },
    onDrop: (event) => {
      if (!isBelowList(event)) {
        return;
      }
      event.preventDefault();
      move(event.dataTransfer.getData(dragType), count);
    }
  };

  const rowClasses = (index: number): string[] => {
    const classes: string[] = [];
    if (index === dragged) {
      classes.push("dragging");
    }
    if (dropAt === index) {
      classes.push("drop-above");
    }
    // The last row carries the line for the position behind it; there is no row after it.
    if (dropAt === count && index === count - 1) {
      classes.push("drop-below");
    }
    return classes;
  };

  return { rowProps, listProps, rowClasses };
}
