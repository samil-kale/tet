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

/** The state a section narrows to, or none: `states` by the names its list shows. */
export function StateFilter<S extends string>({
  states,
  value,
  onChange,
}: {
  states: Readonly<Record<string, S>>;
  value: S | undefined;
  onChange: (state: S | undefined) => void;
}) {
  const names = Object.keys(states);
  const name = names.find((entry) => states[entry] === value);
  return (
    <FilterControl
      title="State"
      value={name}
      options={names}
      isPicked={(option) => option === name}
      onPick={(option) => onChange(states[option] === value ? undefined : states[option])}
      onClear={() => onChange(undefined)}
    />
  );
}

/** One person a section narrows to, or none. */
export function PersonFilter({
  title,
  value,
  people,
  onChange,
}: {
  title: string;
  value: string | undefined;
  people: string[];
  onChange: (person: string | undefined) => void;
}) {
  return (
    <FilterControl
      title={title}
      value={value}
      options={people}
      isPicked={(option) => value === option}
      onPick={(option) => onChange(value === option ? undefined : option)}
      onClear={() => onChange(undefined)}
    />
  );
}

/** The labels a section narrows to, every one carried; none narrows nothing. */
export function LabelFilter({ labels, options, onChange }: { labels: string[]; options: string[]; onChange: (labels: string[]) => void }) {
  return (
    <FilterControl
      title="Label"
      value={labels.length === 0 ? undefined : labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1}`}
      options={options}
      isPicked={(option) => labels.includes(option)}
      onPick={(option) => onChange(labels.includes(option) ? labels.filter((label) => label !== option) : [...labels, option])}
      onClear={() => onChange([])}
      several
    />
  );
}
