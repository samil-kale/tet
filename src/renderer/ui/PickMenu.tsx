import { useRef, type ReactNode } from "react";
import { SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { CheckIcon } from "./icons";
import { MenuButton, type MenuButtonHandle } from "./MenuButton";
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
  /** Caps the list's width in px: longer options end in an ellipsis. */
  maxWidth?: number;
  /** A press on the button, which may fetch the options. */
  onOpen?: () => void;
  /** What the button shows. */
  children: ReactNode;
}

/** A button of the caller's own look and the list it opens, marking what is picked: `Dropdown`'s list. */
export function PickMenu({ options, isPicked, onPick, several, className, title, maxWidth, onOpen, children }: PickMenuProps) {
  const menu = useRef<MenuButtonHandle>(null);
  const filter = useOptionFilter(
    options ?? [],
    (option) => option,
    (option) => {
      if (!several) {
        menu.current?.close();
      }
      onPick(option);
    },
  );

  const empty = options === undefined ? "Loading..." : options.length === 0 ? "None" : "No matches";
  const entryOf =
    (marked: boolean) =>
    (option: string): ContextMenuEntry => ({
      label: option,
      icon: marked ? <CheckIcon className="line-icon" /> : <span className="line-icon" />,
      keepsOpen: several,
      run: () => onPick(option),
    });
  // What is picked leads under its heading, the rest follows below a separator.
  const picked: string[] = [];
  const rest: string[] = [];
  for (const option of filter.matching) {
    (isPicked(option) ? picked : rest).push(option);
  }
  const pickedGroup: ContextMenuEntry[] = picked.length > 0 ? [{ label: "Selected", heading: true }, ...picked.map(entryOf(true))] : [];
  const separator: ContextMenuEntry[] = picked.length > 0 && rest.length > 0 ? [SEPARATOR] : [];
  const entries: ContextMenuEntry[] =
    filter.matching.length === 0 ? [{ label: empty }] : [...pickedGroup, ...separator, ...rest.map(entryOf(false))];

  return (
    <MenuButton
      ref={menu}
      className={className}
      title={title}
      entries={entries}
      menuClassName="pick-menu"
      maxWidth={maxWidth}
      header={filter.field}
      onOpen={() => {
        filter.reset();
        onOpen?.();
      }}
    >
      {children}
    </MenuButton>
  );
}
