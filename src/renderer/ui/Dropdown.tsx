import { SEPARATOR, useAnchoredMenu, type ContextMenuEntry } from "./ContextMenu";
import { ChevronIcon } from "./icons";
import { useOptionFilter } from "./use-option-filter";

/** Taller lists scroll. */
const MAX_LIST_HEIGHT = 300;

/** Gap between the open list and the window's bottom edge. */
const WINDOW_MARGIN = 8;

/** The cap of a list opened below the button `rect` is of: the room below it, or `ContextMenu` would
 *  clamp it upward over the button. */
export function listMaxHeight(rect: DOMRect): number {
  return Math.min(MAX_LIST_HEIGHT, window.innerHeight - rect.bottom - WINDOW_MARGIN);
}

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** A line under it, setting it apart from the options that follow. */
  separatorAfter?: boolean;
}

interface DropdownProps<T extends string> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** As wide as its longest option rather than its row, so picking another never resizes it. */
  fit?: boolean;
}

/**
 * A `<select>` stand-in on `ContextMenu`: Chrome draws a native select's open list itself and
 * ignores CSS colors for the highlighted row.
 */
export function Dropdown<T extends string>({ value, options, onChange, disabled, fit }: DropdownProps<T>) {
  const menu = useAnchoredMenu((rect) => ({
    x: rect.left,
    y: rect.bottom,
    width: rect.width,
    maxHeight: listMaxHeight(rect),
  }));
  const selected = options.find((option) => option.value === value);

  const filter = useOptionFilter(
    options,
    (option) => option.label,
    (option) => {
      menu.close();
      onChange(option.value);
    },
  );

  // The separators set groups apart; a filtered list has none to set apart.
  const entries: ContextMenuEntry[] =
    filter.matching.length === 0
      ? [{ label: "No matches" }]
      : filter.matching.flatMap((option, index) => {
          const entry: ContextMenuEntry = { label: option.label, run: () => onChange(option.value) };
          return !filter.filtering && option.separatorAfter && index < filter.matching.length - 1 ? [entry, SEPARATOR] : [entry];
        });

  return (
    <div className={fit ? "select-field fit" : "select-field"}>
      <button
        type="button"
        className={menu.isOpen ? "dropdown-trigger open" : "dropdown-trigger"}
        disabled={disabled}
        onMouseDown={(event) => {
          filter.reset();
          menu.open(event);
        }}
      >
        {fit ? (
          // Every label in one cell, the others hidden: the widest sets the width.
          <span className="dropdown-fit">
            {options.map((option) => (
              <span key={option.value} className={option === selected ? undefined : "dropdown-fit-other"}>
                {option.label}
              </span>
            ))}
          </span>
        ) : (
          selected?.label
        )}
      </button>
      <ChevronIcon expanded className="select-chevron" />
      {menu.render(() => entries, "dropdown-menu", filter.field)}
    </div>
  );
}
