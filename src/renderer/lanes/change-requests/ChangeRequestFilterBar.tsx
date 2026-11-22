import type { ChangeRequestFilter } from "../../../shared/types/providers";
import { LabelFilter, PersonFilter, StateFilter } from "../../ui/FilterControl";
import type { TrackedOptions } from "../../ui/use-tracked-list";

const STATES = { Open: "open", Merged: "merged", Closed: "closed" } as const;

/** The change requests section's filters, as the Issues section's (IssueFilterBar) and whose review
 *  one asks for beside them. */
export function ChangeRequestFilterBar({
  filter,
  options,
  onChange,
}: {
  filter: ChangeRequestFilter;
  options: TrackedOptions;
  onChange: (filter: ChangeRequestFilter) => void;
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
      <PersonFilter
        title="Reviewer"
        value={filter.reviewer}
        people={options.people}
        onChange={(reviewer) => onChange({ ...filter, reviewer })}
      />
      <LabelFilter labels={filter.labels} options={options.labels} onChange={(labels) => onChange({ ...filter, labels })} />
    </div>
  );
}
