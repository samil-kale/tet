import { useAnchoredMenu, type ContextMenuEntry } from "./ContextMenu";
import { ChevronIcon } from "./icons";

/** Taller lists scroll. */
const MAX_LIST_HEIGHT = 300;

/** Gap between the open list and the window's bottom edge. */
const WINDOW_MARGIN = 8;

interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

interface DropdownProps<T extends string> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
}

/**
 * A `<select>` stand-in on `ContextMenu`: Chrome draws a native select's open list itself and
 * ignores CSS colors for the highlighted row.
 */
export function Dropdown<T extends string>({ value, options, onChange }: DropdownProps<T>) {
  const menu = useAnchoredMenu((rect) => ({
    x: rect.left,
    y: rect.bottom,
    width: rect.width,
    // Capped to the room below, or `ContextMenu` would clamp it upward over the trigger.
    maxHeight: Math.min(MAX_LIST_HEIGHT, window.innerHeight - rect.bottom - WINDOW_MARGIN)
  }));
  const selected = options.find((option) => option.value === value);

  const entries: ContextMenuEntry[] = options.map((option) => ({
    label: option.label,
    run: () => onChange(option.value)
  }));

  return (
    <div className="select-field">
      <button
        type="button"
        className={menu.isOpen ? "dropdown-trigger open" : "dropdown-trigger"}
        onMouseDown={menu.open}
      >
        {selected?.label}
      </button>
      <ChevronIcon expanded className="select-arrow" />
      {menu.render(() => entries, "dropdown-menu")}
    </div>
  );
}
