import type { ReactNode } from "react";
import { useAnchoredMenu, type ContextMenuEntry } from "./ContextMenu";
import { MAX_LIST_HEIGHT, WINDOW_MARGIN } from "./Dropdown";
import { CheckIcon } from "./icons";
import { useOptionFilter } from "./use-option-filter";

interface PickMenuProps {
  /** Undefined while they are on their way. */
  options: string[] | undefined;
  isPicked: (option: string) => boolean;
  /** Takes the option, or takes it back where it is picked. */
  onPick: (option: string) => void;
  /** Several can be picked, so the list stays up for the next. */
  several?: boolean;
  /** The button's, with `open` beside it while the list is up. */
  className: string;
  title?: string;
  /** A press on the button, which may fetch the options. */
  onOpen?: () => void;
  /** What the button shows. */
  children: ReactNode;
}

/** A button of the caller's own look and the list it opens, marking what is picked: `Dropdown`'s list. */
export function PickMenu({ options, isPicked, onPick, several, className, title, onOpen, children }: PickMenuProps) {
  const menu = useAnchoredMenu((rect) => ({
    x: rect.left,
    y: rect.bottom,
    flipX: rect.right,
    maxHeight: Math.min(MAX_LIST_HEIGHT, window.innerHeight - rect.bottom - WINDOW_MARGIN),
  }));
  const filter = useOptionFilter(
    options ?? [],
    (option) => option,
    (option) => {
      if (!several) {
        menu.close();
      }
      onPick(option);
    },
  );

  const empty = options === undefined ? "Loading..." : options.length === 0 ? "None" : "No matches";
  const entries: ContextMenuEntry[] =
    filter.matching.length === 0
      ? [{ label: empty }]
      : filter.matching.map((option) => ({
          label: option,
          icon: isPicked(option) ? <CheckIcon className="tree-icon" /> : <span className="tree-icon" />,
          keepsOpen: several,
          run: () => onPick(option),
        }));

  return (
    <>
      <button
        type="button"
        className={menu.isOpen ? `${className} open` : className}
        title={title}
        onMouseDown={(event) => {
          filter.reset();
          menu.open(event);
          onOpen?.();
        }}
      >
        {children}
      </button>
      {menu.render(() => entries, "pick-menu", filter.field)}
    </>
  );
}
