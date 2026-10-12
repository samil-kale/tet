import type { ReactNode } from "react";
import { SearchIcon } from "./icons";

interface FilterFieldProps {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Focused as it appears: a field in a menu that opens to be typed into (`Dropdown`'s). */
  autoFocus?: boolean;
  /** Enter in the field, e.g. to take the first match. */
  onEnter?: () => void;
  /** Toggles standing inside the field, at its right edge (the SEARCH section's three). */
  children?: ReactNode;
}

/** The box a section filters its rows with: a search icon, then the text the rows are matched against. */
export function FilterField({ placeholder, value, onChange, autoFocus, onEnter, children }: FilterFieldProps) {
  return (
    <div className={children ? "filter-field with-toggles" : "filter-field"}>
      <SearchIcon className="filter-icon" />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onEnter && ((event) => event.key === "Enter" && onEnter())}
      />
      {children}
    </div>
  );
}
