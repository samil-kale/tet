import { useState } from "react";
import { SEPARATOR, useAnchoredMenu, type ContextMenuEntry } from "./ContextMenu";
import { FilterField } from "./FilterField";
import { ChevronIcon } from "./icons";

/** Taller lists scroll. */
const MAX_LIST_HEIGHT = 300;

/** From this many options a list has a filter field above it, which Enter takes the first match of. */
const FILTER_FROM = 10;

/** Gap between the open list and the window's bottom edge. */
const WINDOW_MARGIN = 8;

interface DropdownOption<T extends string> {
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
    // Capped to the room below, or `ContextMenu` would clamp it upward over the trigger.
    maxHeight: Math.min(MAX_LIST_HEIGHT, window.innerHeight - rect.bottom - WINDOW_MARGIN),
  }));
  const selected = options.find((option) => option.value === value);

  const [query, setQuery] = useState("");
  const filterable = options.length >= FILTER_FROM;
  const needle = filterable ? query.trim().toLowerCase() : "";
  const matching = needle === "" ? options : options.filter((option) => option.label.toLowerCase().includes(needle));

  // The separators set groups apart; a filtered list has none to set apart.
  const entries: ContextMenuEntry[] =
    matching.length === 0
      ? [{ label: "No matches" }]
      : matching.flatMap((option, index) => {
          const entry: ContextMenuEntry = { label: option.label, run: () => onChange(option.value) };
          return needle === "" && option.separatorAfter && index < matching.length - 1 ? [entry, SEPARATOR] : [entry];
        });

  return (
    <div className={fit ? "select-field fit" : "select-field"}>
      <button
        type="button"
        className={menu.isOpen ? "dropdown-trigger open" : "dropdown-trigger"}
        disabled={disabled}
        onMouseDown={(event) => {
          setQuery("");
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
      {menu.render(
        () => entries,
        "dropdown-menu",
        filterable && (
          <FilterField
            placeholder="Filter"
            value={query}
            onChange={setQuery}
            autoFocus
            onEnter={() => {
              if (matching.length > 0) {
                menu.close();
                onChange(matching[0].value);
              }
            }}
          />
        ),
      )}
    </div>
  );
}
