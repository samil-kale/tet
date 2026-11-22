import type { IssueFilter } from "../../../shared/types/providers";
import { LabelFilter, PersonFilter, StateFilter } from "../../ui/FilterControl";
import type { TrackedOptions } from "../../ui/use-tracked-list";

const STATES = { Open: "open", Closed: "closed" } as const;

/** The filter's row under the Issues section's field: what the host narrows the list to. */
export function IssueFilterBar({
  filter,
  options,
  onChange,
}: {
  filter: IssueFilter;
  options: TrackedOptions;
  onChange: (filter: IssueFilter) => void;
}) {
  return (
    <div className="issue-filter-bar">
      <StateFilter states={STATES} value={filter.state} onChange={(state) => onChange({ ...filter, state })} />
      <PersonFilter title="Author" value={filter.author} people={options.people} onChange={(author) => onChange({ ...filter, author })} />
      <PersonFilter
        title="Assignee"
        value={filter.assignee}
        people={options.people}
        onChange={(assignee) => onChange({ ...filter, assignee })}
      />
      <LabelFilter labels={filter.labels} options={options.labels} onChange={(labels) => onChange({ ...filter, labels })} />
    </div>
  );
}
