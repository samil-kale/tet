import type { ReactNode } from "react";
import { useAnchoredMenu, type ContextMenuEntry } from "./ContextMenu";
import { MAX_LIST_HEIGHT, WINDOW_MARGIN } from "./Dropdown";
import { CheckIcon } from "./icons";

interface PickMenuOptions {
  /** Undefined while they are on their way. */
  options: string[] | undefined;
  isPicked: (option: string) => boolean;
  /** Takes the option, or takes it back where it is picked. */
  onPick: (option: string) => void;
  /** Several can be picked, so the list stays up for the next. */
  several?: boolean;
}

/**
 * A list to pick from, opened from a button by `open` as its `onMouseDown` and marking what is picked:
 * `Dropdown`'s list, for a trigger of the caller's own.
 */
export function usePickMenu({ options, isPicked, onPick, several }: PickMenuOptions): {
  open: (event: React.MouseEvent<HTMLElement>) => void;
  isOpen: boolean;
  render: () => ReactNode;
} {
  const menu = useAnchoredMenu((rect) => ({
    x: rect.left,
    y: rect.bottom,
    flipX: rect.right,
    maxHeight: Math.min(MAX_LIST_HEIGHT, window.innerHeight - rect.bottom - WINDOW_MARGIN),
  }));

  const entries: ContextMenuEntry[] =
    options === undefined
      ? [{ label: "Loading..." }]
      : options.length === 0
        ? [{ label: "None" }]
        : options.map((option) => ({
            label: option,
            icon: isPicked(option) ? <CheckIcon className="tree-icon" /> : <span className="tree-icon" />,
            keepsOpen: several,
            run: () => onPick(option),
          }));

  return {
    open: menu.open,
    isOpen: menu.isOpen,
    render: () => menu.render(() => entries, "pick-menu"),
  };
}
