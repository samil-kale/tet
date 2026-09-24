import { useState, type DragEvent, type HTMLAttributes } from "react";

/** Drag-reordering, shared by both sidebar lists. Each list supplies its own drag type (a row
 *  dragged over a terminal must not be pasted into it, and no other list may take the drop), its
 *  payload (an id, or the position where an entry can appear twice), and the move itself. */
interface DragReorderOptions {
  /** This list's own MIME type, e.g. "application/x-tet-project". */
  dragType: string;
  /** The row count; index `count` stands for the end of the list. */
  count: number;
  /** What the drag carries for the row at `index`. */
  payloadOf: (index: number) => string;
  /** The row that payload names at drop time, or -1 when gone. */
  indexOf: (payload: string) => number;
  /** The row at `from` goes to insertion index `to`. See `reorder`. */
  onMove: (from: number, to: number) => void;
}

type RowElement = HTMLDivElement;

interface DragReorder {
  /** Spread onto each row, with its index. */
  rowProps: (index: number) => HTMLAttributes<RowElement> & { draggable: true };
  /** Spread onto the rows' container: the empty space below the last row is "the end". */
  listProps: HTMLAttributes<RowElement>;
  /** The row's drag classes: "dragging", "drop-above", "drop-below". */
  rowClasses: (index: number) => string[];
}

/** The list with the row at `from` moved to insertion index `to`. */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  const moved = items.filter((_, position) => position !== from);
  // With the row removed, a target past it is one index closer.
  moved.splice(to > from ? to - 1 : to, 0, items[from]);
  return moved;
}

export function useDragReorder({ dragType, count, payloadOf, indexOf, onMove }: DragReorderOptions): DragReorder {
  const [dragged, setDragged] = useState<number | null>(null);
  /** The insertion index the dragged row would take. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  /** Below a row once the pointer is past its middle. The drawn line and the drop both use this,
   *  so they cannot disagree. */
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
    // NaN and -1 both fail this, so an unresolvable drop moves nothing.
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
      // Read off the drag, not state: it also rejects a file dragged in from outside.
      if (!event.dataTransfer.types.includes(dragType)) {
        return;
      }
      // Only a prevented dragover makes an element a drop target.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropAt(insertionIndex(event, index));
    },
    onDrop: (event) => {
      // A file still lands here (main.tsx prevents every file's dragover); its getData is "", and
      // Number("") is row 0.
      if (!event.dataTransfer.types.includes(dragType)) {
        return;
      }
      event.preventDefault();
      // From the event: the dragover state only draws the line, and a drop must not wait on it.
      move(event.dataTransfer.getData(dragType), insertionIndex(event, index));
    },
    onDragEnd: end
  });

  /** The empty space below the last row. Row drags bubble here too, and are left to the row. */
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
      if (!isBelowList(event) || !event.dataTransfer.types.includes(dragType)) {
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
    // The end of the list has no row, so the last row draws that line.
    if (dropAt === count && index === count - 1) {
      classes.push("drop-below");
    }
    return classes;
  };

  return { rowProps, listProps, rowClasses };
}
