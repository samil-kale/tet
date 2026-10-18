import { useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton";
import { ClearIcon, SearchIcon } from "./icons";

interface FilterFieldProps {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Focused as it appears: a field in a menu that opens to be typed into (`Dropdown`'s). */
  autoFocus?: boolean;
  /** Enter in the field, e.g. to take the first match. */
  onEnter?: () => void;
  /** Toggles standing inside the field, before the clear button (the SEARCH section's three). */
  children?: ReactNode;
}

/**
 * The box a section filters its rows with: a search icon, then the text the rows are matched
 * against, and at its right edge the button clearing it, disabled while there is none — every
 * filter alike, so no header carries one of its own.
 */
export function FilterField({ placeholder, value, onChange, autoFocus, onEnter, children }: FilterFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={children ? "filter-field with-toggles" : "filter-field"}>
      <SearchIcon className="filter-icon" />
      <input
        ref={input}
        type="text"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onEnter && ((event) => event.key === "Enter" && onEnter())}
      />
      <span className="filter-toggles">
        {children}
        <IconButton
          title="Clear"
          disabled={value === ""}
          onClick={() => {
            onChange("");
            // Typing goes on where it was.
            input.current?.focus();
          }}
        >
          <ClearIcon />
        </IconButton>
      </span>
    </div>
  );
}
