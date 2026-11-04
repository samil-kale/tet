import { memo, useState } from "react";
import type { ProjectRef } from "../../../shared/types/project";
import type { Issue, IssueFilter } from "../../../shared/types/providers";
import { issueFileName, type OpenEditor } from "../../editor/editor-tab";
import { dayOf, Person } from "../../editor/IssueView";
import type { ResolvedRef } from "../../resolved-ref";
import { useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { filled, prompt, refusal, singleField, type PromptFields } from "../../ui/Dialog";
import { Field, TextField } from "../../ui/Field";
import { FilterField } from "../../ui/FilterField";
import { IconButton } from "../../ui/IconButton";
import { LinkIcon, MessageIcon, PlusIcon, SyncIcon } from "../../ui/icons";
import { useStoredJson } from "../../ui/layout-storage";
import { setDragName } from "../../ui/row-drag";
import { Section } from "../../ui/Section";
import { useTextContextMenu } from "../../ui/use-text-context-menu";
import { IssueFilterBar } from "./IssueFilterBar";
import { useIssues } from "./use-issues";

const INITIAL_FILTER: IssueFilter = { state: "open", labels: [] };

interface NewIssue {
  title: string;
  body: string;
}

/** The fields of a new issue. No upload here: nothing is written until the question's answer. */
function NewIssueFields({ value, onChange, error, busy, field }: PromptFields<NewIssue>) {
  const textMenu = useTextContextMenu((body) => onChange((current) => ({ ...current, body })));
  return (
    <>
      <TextField
        label="Title"
        value={value.title}
        onChange={(title) => onChange((current) => ({ ...current, title }))}
        disabled={busy}
        ref={field}
        error={error}
      />
      <Field label="Description">
        <textarea
          className="issue-new-body"
          value={value.body}
          disabled={busy}
          onChange={(event) => onChange({ ...value, body: event.target.value })}
          onContextMenu={textMenu.onContextMenu}
        />
        {textMenu.menu}
      </Field>
    </>
  );
}

function IssueRow({
  issue,
  projectId,
  onOpen,
  onMenu,
}: {
  issue: Issue;
  projectId: string;
  onOpen: (how: OpenEditor) => void;
  onMenu: (event: React.MouseEvent) => void;
}) {
  return (
    <div
      className="list-row issue-row"
      title={[`#${issue.number} ${issue.title}`, ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(", ")}`] : [])].join("\n")}
      draggable
      onDragStart={(event) =>
        setDragName(event.dataTransfer, { kind: "issue", name: issue.url, issue: { projectId, number: issue.number } })
      }
      onClick={() => onOpen({})}
      onDoubleClick={() => onOpen({ keep: true })}
      onContextMenu={onMenu}
    >
      <span className="issue-main">
        <span className="list-label">{issue.title}</span>
        <span className="issue-meta">
          #{issue.number} · created {dayOf(issue.createdAt)}, by {issue.author}
        </span>
      </span>
      {issue.assignee !== undefined && <Person login={issue.assignee} avatar={issue.avatars[issue.assignee]} />}
      <span className="issue-comments">
        <MessageIcon className="tree-icon" />
        {issue.comments}
      </span>
    </div>
  );
}

/**
 * The project's issues, on its tracker: a click opens one in the preview tab, read-only, a double
 * click keeps it, as the Explorer's files, and a drag onto a terminal hands it to the tab. All
 * this writes to the tracker is a new issue, whose tab changes it from there. The source is the
 * project's setting, so a worktree, which changes none, offers no button for it.
 */
export const IssueList = memo(function IssueList({
  resolved,
  shown,
  onOpenFile,
}: {
  resolved: ResolvedRef;
  shown: boolean;
  onOpenFile: (ref: ProjectRef, path: string, how?: OpenEditor) => void;
}) {
  const { projectId, worktree } = resolved.ref;
  const [filter, setFilter] = useStoredJson(`issues-filter.${projectId}`, INITIAL_FILTER);
  const { issues, source, options, busy, reload, holdBusy, releaseBusy, reloadThenRelease } = useIssues(projectId, filter, shown);
  const [title, setTitle] = useState("");
  const needle = title.trim().toLowerCase();
  const shownIssues = (issues ?? []).filter((issue) => issue.title.toLowerCase().includes(needle));
  const menu = useContextMenu<Issue>();

  const askSource = async (): Promise<void> => {
    await prompt({
      title: "Issue source",
      detail: "Empty shows this repository's own issues. Saved in tet.json, so everyone working on this project sees the same source.",
      confirmLabel: "Save",
      value: source ?? "",
      ready: () => true,
      render: singleField("Project or repository path"),
      submit: async (typed) => refusal(await window.tet.issues.setSource(projectId, typed)),
    });
  };

  const askNewIssue = async (): Promise<void> => {
    let created: number | undefined;
    await prompt<NewIssue>({
      title: "New issue",
      confirmLabel: "Create",
      value: { title: "", body: "" },
      ready: (value) => filled(value.title),
      render: (fields) => <NewIssueFields {...fields} />,
      submit: async ({ title: typed, body }) => {
        holdBusy();
        const result = await window.tet.issues.create(projectId, typed.trim(), body);
        if (result.ok) {
          created = result.number;
        } else {
          releaseBusy();
        }
        return refusal(result);
      },
    });
    if (created !== undefined) {
      reloadThenRelease();
      onOpenFile(resolved.ref, issueFileName(created), { issue: created, keep: true });
    }
  };

  const menuEntries = (issue: Issue): ContextMenuEntry[] => [
    { label: "Open in Browser", run: () => void window.tet.shell.openUrl(issue.url) },
    { label: "Copy Link", run: () => void navigator.clipboard.writeText(issue.url) },
  ];

  return (
    <div className={`lane-content${shown ? "" : " hidden"}`}>
      <Section
        title="ISSUES"
        count={issues?.length}
        detail={source}
        busy={busy}
        actions={
          <>
            {worktree === undefined && (
              <IconButton title="Issue source..." onClick={() => void askSource()}>
                <LinkIcon />
              </IconButton>
            )}
            <IconButton title="Refresh" disabled={busy} onClick={reload}>
              <SyncIcon />
            </IconButton>
            <IconButton title="New Issue..." onClick={() => void askNewIssue()}>
              <PlusIcon />
            </IconButton>
          </>
        }
      >
        <div className="filter-list">
          <FilterField placeholder="Filter issues..." value={title} onChange={setTitle} />
          <IssueFilterBar filter={filter} options={options} onChange={setFilter} />
          <div className="tree">
            {shownIssues.map((issue) => (
              <IssueRow
                key={issue.number}
                issue={issue}
                projectId={projectId}
                onOpen={(how) => onOpenFile(resolved.ref, issueFileName(issue.number), { ...how, issue: issue.number })}
                onMenu={(event) => menu.open(event, issue)}
              />
            ))}
          </div>
        </div>
        {menu.render(menuEntries)}
      </Section>
    </div>
  );
});
