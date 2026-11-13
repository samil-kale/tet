import { useEffect, useState, type HTMLAttributes } from "react";

interface DropTarget<K> {
  /** What a drag of the type is held over; undefined while none is. */
  over: K | undefined;
  /** Spread onto what takes the drop, `key` telling it apart where a view holds several (an issue's
   *  row, by its number). */
  dropPropsOf: (key: K) => HTMLAttributes<HTMLElement>;
}

/**
 * Takes the drop of a drag carrying `dragType`, its payload handed to `onDrop` with the key of what
 * it fell on. A type of its own: `dragover` sees the types but cannot read a payload.
 */
export function useDropTarget<K = true>(dragType: string, onDrop: (payload: string, key: K) => void): DropTarget<K> {
  // Boxed, so a key that is itself falsy is still one.
  const [over, setOver] = useState<{ key: K }>();

  // A cancelled drag fires neither `drop` nor `dragleave` here, only `dragend` at its source.
  useEffect(() => {
    if (over === undefined) {
      return;
    }
    const clear = (): void => setOver(undefined);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, [over]);

  const dropPropsOf = (key: K): HTMLAttributes<HTMLElement> => ({
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(dragType)) {
        return;
      }
      // Only a prevented dragover makes an element a drop target; the drags taken here allow a move
      // alone (drag-reorder.ts), whatever the drop then does.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver((current) => (current?.key === key ? current : { key }));
    },
    onDragLeave: (event) => {
      // Also fires for children; only leaving the target itself counts.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setOver((current) => (current?.key === key ? undefined : current));
      }
    },
    onDrop: (event) => {
      if (!event.dataTransfer.types.includes(dragType)) {
        return;
      }
      event.preventDefault();
      setOver(undefined);
      onDrop(event.dataTransfer.getData(dragType), key);
    },
  });
  return { over: over?.key, dropPropsOf };
}
