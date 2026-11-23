import { useState, useRef } from "react";
import { linkedIssueNumber, type TrackedDetail, type TrackedField, type TrackedFieldValue } from "../../../shared/types/providers";
import type { TrackedSession } from "../../../shared/types/terminals";
import { AgentIcon } from "../../ui/agent-icons";
import { IconButton } from "../../ui/IconButton";
import { CloseIcon, GearIcon, PlusIcon, TrashIcon } from "../../ui/icons";
import { PickMenu } from "../../ui/PickMenu";
import { openTrackedSession, unlinkTrackedSession } from "../editor-tab";
import { changeRequestOf, listed, trackedNoun, trackedRefOf } from "./tracked-words";
import type { AskedField } from "./tracked-fields";
import { filled, prompt, singleField } from "../../ui/Dialog";
import { FieldRow, TextField, TextAreaField, Checkbox } from "../../ui/Field";
import type { TrackedActions } from "./tracked-actions";
import { Person } from "./Person";
import { confirmDeleteOnTracker } from "./TrackedBar";
import { ActionLink } from "../../ui/ActionLink";
import type { ContextMenuEntry } from "../../ui/ContextMenu";
import { MenuButton } from "../../ui/MenuButton";

/** The widest a list opened from the side column's icons gets, in px: longer names end in an ellipsis. */
export const SIDE_MENU_MAX_WIDTH = 300;

export function SideSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="issue-side-section">
      <div className="issue-side-title">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/** The session linked to the issue (`TrackedSession`), first in the side column: as its tab, its
 *  agent's icon and title, over the repository or worktree it is in and whether it is archived. A
 *  click brings it to the front, reopening an archived one; its button on hover takes it off the
 *  issue. */
export function SessionSection({ issue, session }: { issue: TrackedDetail; session: TrackedSession | undefined }) {
  return (
    <SideSection title="Session">
      {session === undefined ? (
        <span className="issue-none">None</span>
      ) : (
        <div className="issue-session" onClick={() => void openTrackedSession(session)}>
          <AgentIcon agentId={session.agentId} className="line-icon" />
          <span className="issue-session-text">
            <span>{session.title || "New session"}</span>
            <span className="issue-session-where">
              {session.worktree ?? "repository"} · {session.archived ? "archived" : "open"}
            </span>
          </span>
          <IconButton
            title={`Unlink from ${trackedNoun(issue)}`}
            isolated
            onClick={() => void unlinkTrackedSession(session, trackedRefOf(issue))}
          >
            <CloseIcon />
          </IconButton>
        </div>
      )}
    </SideSection>
  );
}

/** A section of what the issue has of a list, and the list to change it from: every pick is set at
 *  once. What it has stays offered, whether or not the tracker still lists it. `several` for more
 *  than one at a time. */
export function PickSection({
  title,
  picked,
  several,
  editable,
  load,
  onChange,
  children,
}: {
  title: string;
  picked: string[];
  several: boolean;
  editable: boolean;
  load: () => Promise<string[] | undefined>;
  onChange: (picked: string[]) => void;
  children: React.ReactNode;
}) {
  const [options, setOptions] = useState<string[]>();
  // One request however many times the menu is opened; a failed one is asked again.
  const asked = useRef<Promise<void> | undefined>(undefined);
  return (
    <SideSection
      title={title}
      action={
        editable && (
          <PickMenu
            className="icon-button"
            title={`Change ${title}`}
            maxWidth={SIDE_MENU_MAX_WIDTH}
            options={options && [...new Set([...options, ...picked])]}
            isPicked={(option) => picked.includes(option)}
            onPick={(option) => {
              const rest = picked.filter((entry) => entry !== option);
              onChange(picked.includes(option) ? rest : several ? [...picked, option] : [option]);
            }}
            several={several}
            onOpen={() => {
              if (options === undefined) {
                asked.current ??= load().then((loaded) => {
                  asked.current = undefined;
                  setOptions(loaded);
                });
              }
            }}
          >
            <GearIcon />
          </PickMenu>
        )
      }
    >
      {children}
    </SideSection>
  );
}

/** A field that is typed rather than picked. */
export type TypedField = Exclude<AskedField, { kind: "timelog" }>;

/** What a typed field's dialog tells of what to type. */
export const TYPING_HINTS: Record<TypedField["kind"], string> = {
  text: "Some text",
  number: "A number",
  date: "A date",
  duration: "For example 3h 30m",
};

/** The question a text, a number, a date or a duration is changed in; an empty answer takes the value
 *  off, and `edit` answers what the tracker refused. */
export async function askFieldValue(field: TypedField, edit: (value: TrackedFieldValue) => Promise<string | undefined>): Promise<void> {
  await prompt({
    title: `Change ${field.name.toLowerCase()}`,
    detail: `${TYPING_HINTS[field.kind]}. Empty takes it off.`,
    confirmLabel: "Save",
    value: field.value === undefined ? "" : String(field.value),
    ready: () => true,
    render: singleField(field.name, undefined, field.kind === "date" ? "date" : undefined),
    submit: (typed) => {
      const text = typed.trim();
      return edit(text === "" ? null : field.kind === "number" ? Number(text) : text);
    },
  });
}

/** What the time entry's question holds while it is typed. */
export interface TimeEntryDraft {
  timeSpent: string;
  spentAt: string;
  summary: string;
}

/** The question a booking of time is made in; `edit` answers what the tracker refused. */
export async function askTimeEntry(edit: (value: TrackedFieldValue) => Promise<string | undefined>): Promise<void> {
  await prompt<TimeEntryDraft>({
    title: "Add time entry",
    detail: "Track time spent on this issue.",
    confirmLabel: "Save",
    value: { timeSpent: "", spentAt: "", summary: "" },
    ready: (draft) => filled(draft.timeSpent),
    render: ({ value, onChange, error, busy, field: input }) => (
      <>
        <FieldRow>
          <TextField
            label="Time spent"
            placeholder="1h 30m"
            value={value.timeSpent}
            onChange={(timeSpent) => onChange({ ...value, timeSpent })}
            disabled={busy}
            ref={input}
            error={error}
          />
          <TextField
            label="Spent at (optional)"
            type="date"
            value={value.spentAt}
            onChange={(spentAt) => onChange({ ...value, spentAt })}
            disabled={busy}
          />
        </FieldRow>
        <TextAreaField
          label="Summary (optional)"
          value={value.summary}
          onChange={(summary) => onChange({ ...value, summary })}
          disabled={busy}
          sizeKey="time-entry-summary-height"
        />
      </>
    ),
    submit: ({ timeSpent, spentAt, summary }) =>
      edit({ timeSpent: timeSpent.trim(), spentAt: spentAt || undefined, summary: summary.trim() || undefined }),
  });
}

/** Asks for the field's change; `actions.editField` answers what the tracker refused. */
export function askField(field: AskedField, actions: TrackedActions): Promise<void> {
  const edit = (value: TrackedFieldValue) => actions.editField(field.id, value);
  return field.kind === "timelog" ? askTimeEntry(edit) : askFieldValue(field, edit);
}

/** What a group's menu calls the change of one of its fields. */
export function changeLabel(field: AskedField): string {
  return field.kind === "timelog" ? "Add time entry" : `Set ${field.name.toLowerCase()}`;
}

/** The bookings of time an issue has, each with its time, day, who made it and what it was for; one the
 *  viewer's rights allow is taken back after a question. */
export function TimeLogs({
  field,
  avatars,
  actions,
}: {
  field: Extract<TrackedField, { kind: "timelog" }>;
  avatars: TrackedDetail["avatars"];
  actions: TrackedActions;
}) {
  return field.entries.map((entry) => (
    <div key={entry.id} className="issue-time-log">
      <div className="issue-time-log-line">
        <span>{entry.timeSpent}</span>
        {entry.spentAt && <span className="issue-side-name">{entry.spentAt}</span>}
        {entry.removable && (
          <IconButton
            title="Delete..."
            onClick={() =>
              void confirmDeleteOnTracker("time entry").then((answer) =>
                answer ? actions.setField(field.id, { remove: entry.id }) : undefined,
              )
            }
          >
            <TrashIcon />
          </IconButton>
        )}
      </div>
      <div className="issue-side-person">
        <Person login={entry.author} avatar={avatars[entry.author]} />
        <span className="issue-side-name">{entry.author}</span>
      </div>
      {entry.summary && <div className="issue-side-name">{entry.summary}</div>}
    </div>
  ));
}

/** A typed field's value in the side column, "None" where it has none. */
export function FieldValue({ value }: { value: string | number | undefined }) {
  return <span className={value === undefined ? "issue-none" : undefined}>{value ?? "None"}</span>;
}

/** The fields of one group as a section: their values or, where none has one, a sentence offering to
 *  add them; its one button opens a menu of what can be set. */
export function GroupSection({
  title,
  fields,
  avatars,
  actions,
}: {
  title: string;
  fields: AskedField[];
  avatars: TrackedDetail["avatars"];
  actions: TrackedActions;
}) {
  const editable = fields.filter((field) => field.editable);
  const entries: ContextMenuEntry[] = editable.map((field) => ({
    label: changeLabel(field),
    run: () => void askField(field, actions),
  }));
  return (
    <SideSection
      title={title}
      action={
        editable.length > 0 && (
          <MenuButton
            className="icon-button"
            title={`Change ${title}`}
            entries={entries}
            menuClassName="field-menu"
            maxWidth={SIDE_MENU_MAX_WIDTH}
          >
            <PlusIcon />
          </MenuButton>
        )
      }
    >
      {fields.every((field) => field.value === undefined) ? (
        <span className="issue-none">
          {editable.length === 0 ? (
            "None"
          ) : (
            <>
              Add{" "}
              {listed(
                editable,
                (field) => (
                  <ActionLink onClick={() => void askField(field, actions)}>{field.name.toLowerCase()}</ActionLink>
                ),
                "or",
              )}
              .
            </>
          )}
        </span>
      ) : (
        fields.map((field) => (
          <div key={field.id} className="issue-side-row">
            <span className="issue-side-name">{field.name}</span>
            <FieldValue value={field.value} />
          </div>
        ))
      )}
      {fields.map((field) => field.kind === "timelog" && <TimeLogs key={field.id} field={field} avatars={avatars} actions={actions} />)}
    </SideSection>
  );
}

/** What a field's pick holds, as its values are drawn: as labels, people too, or plain text. */
export function PickValue({
  field,
  issue,
  actions,
}: {
  field: Extract<TrackedField, { kind: "pick" }>;
  issue: TrackedDetail;
  actions: TrackedActions;
}) {
  const { viewer } = issue;
  // A linked issue opens in its tab where the project's issues are read from this same repository.
  const opensIssues = changeRequestOf(issue)?.ownIssues === true;
  return (
    <>
      {field.value.length === 0 && <span className="issue-none">None</span>}
      {field.shown === "issues" &&
        field.value.map((name) => {
          const number = linkedIssueNumber(name);
          return (
            <span key={name} className="issue-linked">
              {opensIssues && number !== undefined ? <ActionLink onClick={() => actions.openIssue(number)}>{name}</ActionLink> : name}
            </span>
          );
        })}
      {field.shown !== "text" && field.shown !== "issues" && (
        <div className="issue-labels">
          {field.value.map((label) => (
            <span key={label} className="issue-label">
              {label}
            </span>
          ))}
        </div>
      )}
      {field.shown === "text" && field.value.length > 0 && <span>{field.value.join(", ")}</span>}
      {field.shown === "people" && field.editable && viewer !== undefined && !field.value.includes(viewer) && (
        <ActionLink onClick={() => actions.setField(field.id, field.several ? [...field.value, viewer] : [viewer])}>
          Assign yourself
        </ActionLink>
      )}
    </>
  );
}

/** One field of the issue in the side column, drawn by its kind; where it can be changed, its section
 *  offers how. */
export function FieldSection({ field, issue, actions }: { field: TrackedField; issue: TrackedDetail; actions: TrackedActions }) {
  switch (field.kind) {
    case "pick":
      return (
        <PickSection
          title={field.name}
          picked={field.value}
          several={field.several}
          editable={field.editable}
          load={() => actions.fieldOptions(field.id)}
          onChange={(value) => actions.setField(field.id, value)}
        >
          <PickValue field={field} issue={issue} actions={actions} />
        </PickSection>
      );
    case "flag":
      return (
        <div className="issue-side-section">
          <Checkbox
            label={field.name}
            checked={field.value}
            disabled={!field.editable}
            onChange={(checked) => actions.setField(field.id, checked)}
          />
        </div>
      );
    case "timelog":
      return (
        <SideSection
          title={field.name}
          action={
            field.editable && (
              <IconButton title="Add time entry" onClick={() => void askField(field, actions)}>
                <PlusIcon />
              </IconButton>
            )
          }
        >
          <FieldValue value={field.value} />
          <TimeLogs field={field} avatars={issue.avatars} actions={actions} />
        </SideSection>
      );
    case "text":
    case "number":
    case "date":
    case "duration":
      return (
        <SideSection
          title={field.name}
          action={
            field.editable && (
              <IconButton title={`Change ${field.name}`} onClick={() => void askField(field, actions)}>
                <GearIcon />
              </IconButton>
            )
          }
        >
          <FieldValue value={field.value} />
        </SideSection>
      );
  }
}
