import { useRef } from "react";
import { IconButton } from "./IconButton";
import { ChevronIcon, CloseIcon } from "./icons";
import { PickMenu } from "./PickMenu";

/** The widest a filter's list gets, in px: longer names end in an ellipsis. */
const FILTER_MENU_MAX_WIDTH = 300;

interface FilterControlProps {
  title: string;
  /** What it stands at, as shown after the title; undefined narrows nothing. */
  value: string | undefined;
  options: string[];
  isPicked: (option: string) => boolean;
  /** Takes the option, or takes it back where it is picked. */
  onPick: (option: string) => void;
  onClear: () => void;
  /** Several can be picked, so the list stays up for the next. */
  several?: boolean;
}

/** One filter: its title and value, a list to pick from, and a button clearing it once set
 *  (IntelliJ's). */
export function FilterControl({ title, value, options, isPicked, onPick, onClear, several }: FilterControlProps) {
  const box = useRef<HTMLSpanElement>(null);
  return (
    <span ref={box} className={value === undefined ? "issue-filter" : "issue-filter set"}>
      <PickMenu
        className="issue-filter-trigger"
        maxWidth={FILTER_MENU_MAX_WIDTH}
        alignTo={box}
        options={options}
        isPicked={isPicked}
        onPick={onPick}
        several={several}
      >
        <span className="issue-filter-text">{value === undefined ? title : `${title}: ${value}`}</span>
        {value === undefined && <ChevronIcon expanded />}
      </PickMenu>
      {value !== undefined && (
        <IconButton title={`Clear ${title}`} onClick={onClear}>
          <CloseIcon />
        </IconButton>
      )}
    </span>
  );
}
