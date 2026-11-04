import type { IssueFilter } from "../../../shared/types/providers";
import { IconButton } from "../../ui/IconButton";
import { ChevronIcon, CloseIcon } from "../../ui/icons";
import { usePickMenu } from "../../ui/pick-menu";
import type { IssueOptions } from "./use-issues";

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
function FilterControl({ title, value, options, isPicked, onPick, onClear, several }: FilterControlProps) {
  const menu = usePickMenu({ options, isPicked, onPick, several });

  return (
    <span className={value === undefined ? "issue-filter" : "issue-filter set"}>
      <button type="button" className={menu.isOpen ? "issue-filter-trigger open" : "issue-filter-trigger"} onMouseDown={menu.open}>
        <span className="issue-filter-text">{value === undefined ? title : `${title}: ${value}`}</span>
        {value === undefined && <ChevronIcon expanded />}
      </button>
      {value !== undefined && (
        <IconButton title={`Clear ${title}`} onClick={onClear}>
          <CloseIcon />
        </IconButton>
      )}
      {menu.render()}
    </span>
  );
}

const STATES = { Open: "open", Closed: "closed" } as const;
type StateName = keyof typeof STATES;

/** What is left of the state's list: `state` undefined shows both. */
function stateName(state: IssueFilter["state"]): string | undefined {
  return (Object.keys(STATES) as StateName[]).find((name) => STATES[name] === state);
}

/** The filter's row under the ISSUES section's field: what the host narrows the list to. */
export function IssueFilterBar({
  filter,
  options,
  onChange,
}: {
  filter: IssueFilter;
  options: IssueOptions;
  onChange: (filter: IssueFilter) => void;
}) {
  /** Author and assignee alike: one person, or none. */
  const person = (field: "author" | "assignee", title: string) => (
    <FilterControl
      title={title}
      value={filter[field]}
      options={options.people}
      isPicked={(option) => filter[field] === option}
      onPick={(option) => onChange({ ...filter, [field]: filter[field] === option ? undefined : option })}
      onClear={() => onChange({ ...filter, [field]: undefined })}
    />
  );
  const { labels } = filter;
  return (
    <div className="issue-filter-bar">
      <FilterControl
        title="State"
        value={stateName(filter.state)}
        options={Object.keys(STATES)}
        isPicked={(option) => stateName(filter.state) === option}
        onPick={(option) => {
          const state = STATES[option as StateName];
          onChange({ ...filter, state: filter.state === state ? undefined : state });
        }}
        onClear={() => onChange({ ...filter, state: undefined })}
      />
      {person("author", "Author")}
      {person("assignee", "Assignee")}
      <FilterControl
        title="Label"
        value={labels.length === 0 ? undefined : labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1}`}
        options={options.labels}
        isPicked={(option) => labels.includes(option)}
        onPick={(option) =>
          onChange({ ...filter, labels: labels.includes(option) ? labels.filter((label) => label !== option) : [...labels, option] })
        }
        onClear={() => onChange({ ...filter, labels: [] })}
        several
      />
    </div>
  );
}
