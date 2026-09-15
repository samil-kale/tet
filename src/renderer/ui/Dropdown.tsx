import { useState } from "react";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { ChevronIcon } from "./icons";

/** Taller lists scroll. */
const MAX_LIST_HEIGHT = 300;

/** Gap between the open list and the window's bottom edge. */
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
 * A `<select>` stand-in on `ContextMenu`: Chrome draws a native select's open list itself and
 * ignores CSS colors (`option:hover`/`:checked`) for the highlighted row (measured).
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
          // Capped to the room below, or `ContextMenu` would clamp it upward over the trigger.
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
