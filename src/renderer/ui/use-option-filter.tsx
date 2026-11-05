import { useState, type ReactNode } from "react";
import { FilterField } from "./FilterField";

/** From this many options a list has a filter field above it. */
const FILTER_FROM = 10;

/**
 * What a list's filter field leaves of its options: `field` is that field where the list is long
 * enough for one, the header of its menu, `reset` empties it as the list opens. Enter takes the first
 * match and empties it, for a list that stays up for the next.
 */
export function useOptionFilter<T>(
  options: T[],
  labelOf: (option: T) => string,
  take: (option: T) => void,
): { matching: T[]; filtering: boolean; field: ReactNode; reset: () => void } {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matching = needle === "" ? options : options.filter((option) => labelOf(option).toLowerCase().includes(needle));
  const field = options.length >= FILTER_FROM && (
    <FilterField
      placeholder="Filter"
      value={query}
      onChange={setQuery}
      autoFocus
      onEnter={() => {
        if (matching.length > 0) {
          setQuery("");
          take(matching[0]);
        }
      }}
    />
  );
  return { matching, filtering: needle !== "", field, reset: () => setQuery("") };
}
