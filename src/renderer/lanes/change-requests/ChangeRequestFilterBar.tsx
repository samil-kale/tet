import type { ChangeRequestFilter } from "../../../shared/types/providers";
import type { IssueOptions } from "../../editor/editor-views";
import { FilterControl } from "../../ui/FilterControl";

const STATES = { Open: "open", Merged: "merged", Closed: "closed" } as const;
type StateName = keyof typeof STATES;

/** What is left of the state's list: `state` undefined shows all three. */
function stateName(state: ChangeRequestFilter["state"]): string | undefined {
  return (Object.keys(STATES) as StateName[]).find((name) => STATES[name] === state);
}

/** The change requests section's filters, as the Issues section's (IssueFilterBar) and whose review
 *  one asks for beside them. */
export function ChangeRequestFilterBar({
  filter,
  options,
  onChange,
}: {
  filter: ChangeRequestFilter;
  options: IssueOptions;
  onChange: (filter: ChangeRequestFilter) => void;
}) {
  /** Author, assignee and reviewer alike: one person, or none. */
  const person = (field: "author" | "assignee" | "reviewer", title: string) => (
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
      {person("reviewer", "Reviewer")}
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
