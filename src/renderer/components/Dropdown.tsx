import { useState } from "react";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { ChevronIcon } from "./icons";

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
 * ignored for the highlighted row (measured directly, not assumed) — there is no way to theme
 * it short of not using `<select>`.
 */
export function Dropdown({ value, options, onChange }: DropdownProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; width: number } | null>(null);
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
          setMenu({ x: rect.left, y: rect.bottom, width: rect.width });
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
          entries={entries}
          onClose={() => setMenu(null)}
          className="dropdown-menu"
        />
      )}
    </div>
  );
}
