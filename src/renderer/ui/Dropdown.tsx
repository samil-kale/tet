import { useState } from "react";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { ChevronIcon } from "./icons";

/** The open list's tallest; a longer one scrolls. */
const MAX_LIST_HEIGHT = 300;

/** Kept free between the open list and the window's bottom edge. */
const WINDOW_MARGIN = 8;

interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
}

/**
 * A `<select>` stand-in built from the shared `ContextMenu`: Chrome renders a native select's
 * open list itself, so `option:hover`/`:checked` and every other CSS color on this page are
 * ignored for the highlighted row (measured). There is no way to theme it short of not using
 * `<select>`.
 */
export function Dropdown({ value, options, onChange }: DropdownProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; width: number; maxHeight: number } | null>(null);
  const selected = options.find((option) => option.value === value);

  const entries: ContextMenuEntry[] = options.map((option) => ({
    label: option.label,
    run: () => onChange(option.value)
  }));

  return (
    <div className="select-field">
      <button
        type="button"
        className="dropdown-trigger"
        onMouseDown={(event) => {
          event.stopPropagation();
          if (menu) {
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          // Capped to the room below the trigger, so the list always opens under it: a taller
          // one would be clamped upward over the trigger by `ContextMenu`.
          const maxHeight = Math.min(MAX_LIST_HEIGHT, window.innerHeight - rect.bottom - WINDOW_MARGIN);
          setMenu({ x: rect.left, y: rect.bottom, width: rect.width, maxHeight });
        }}
      >
        {selected?.label}
      </button>
      <ChevronIcon expanded className="select-arrow" />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          width={menu.width}
          maxHeight={menu.maxHeight}
          entries={entries}
          onClose={() => setMenu(null)}
          className="dropdown-menu"
        />
      )}
    </div>
  );
}
