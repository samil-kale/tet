import { useEffect, useState, type HTMLAttributes } from "react";
import type { ProjectRef } from "../../../shared/types/project";
import { ARCHIVABLE_TAB_DRAG_TYPE } from "../../tabs/pane-layout";

interface ArchiveDrop {
  /** An archivable tab is held over the lane. */
  over: boolean;
  /** Spread onto what takes the drop: the lane. */
  dropProps: HTMLAttributes<HTMLElement>;
}

/** Archives the tab of `ref` dropped on the lane, as the tab menu's Archive does. */
export function useArchiveDrop(ref: ProjectRef): ArchiveDrop {
  const [over, setOver] = useState(false);

  // A cancelled drag fires neither `drop` nor `dragleave` here, only `dragend` at the tab.
  useEffect(() => {
    if (!over) {
      return;
    }
    const clear = (): void => setOver(false);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, [over]);

  const dropProps: HTMLAttributes<HTMLElement> = {
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(ARCHIVABLE_TAB_DRAG_TYPE)) {
        return;
      }
      // Only a prevented dragover makes an element a drop target.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    onDragLeave: (event) => {
      // Also fires for children; only leaving the lane itself counts.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setOver(false);
      }
    },
    onDrop: (event) => {
      if (!event.dataTransfer.types.includes(ARCHIVABLE_TAB_DRAG_TYPE)) {
        return;
      }
      event.preventDefault();
      setOver(false);
      void window.tet.tabs.archive(ref, [event.dataTransfer.getData(ARCHIVABLE_TAB_DRAG_TYPE)]);
    },
  };
  return { over, dropProps };
}
