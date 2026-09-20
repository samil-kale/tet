import type { ReactNode } from "react";
import { SearchIcon } from "./icons";

interface FilterFieldProps {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Toggles standing inside the field, at its right edge (the SEARCH pane's three). */
  children?: ReactNode;
}

/** The box a pane filters its rows with: a search icon, then the text the rows are matched against. */
export function FilterField({ placeholder, value, onChange, children }: FilterFieldProps) {
  return (
    <div className="filter-field">
      <SearchIcon className="filter-icon" />
      <input type="text" placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      {children}
    </div>
  );
}
