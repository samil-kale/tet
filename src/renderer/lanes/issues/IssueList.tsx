import { memo, useState } from "react";
import type { ProjectRef } from "../../../shared/types/project";
import { DEFAULT_ISSUE_FILTER, isUnread, issueFileName, type Issue } from "../../../shared/types/providers";
import { issueGone, openIssueInAgent, type OpenEditor } from "../../editor/editor-tab";
import { loadProjectIssueImage, reloadIssueTabs } from "../../editor/editor-views";
import { keepAllIssuesSeen, useIssuesSeen } from "../../editor/issue-seen";
import { newIssueUrl } from "../../editor/issue-text";
import { askIssueTitle, confirmDeleteIssue, dayOf, issueAgentEntries, Person, TextBox, type TextRendering } from "../../editor/IssueView";
import type { ResolvedRef } from "../../resolved-ref";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { filled, prompt, refusal, singleField, type PromptFields } from "../../ui/Dialog";
import { FieldGroup, TextField } from "../../ui/Field";
import { FilterField } from "../../ui/FilterField";
import { IconButton } from "../../ui/IconButton";
import { LinkIcon, ListCheckIcon, PlusIcon, SyncIcon, UserPlusIcon } from "../../ui/icons";
import { useStoredJson } from "../../ui/layout-storage";
import { notify } from "../../ui/Notices";
import { ISSUE_DRAG_TYPE } from "../../tabs/pane-layout";
import { Section } from "../../ui/Section";
import { useAgents } from "../../ui/use-agents";
import { IssueFilterBar } from "./IssueFilterBar";
import { useIssues } from "./use-issues";

/** The description's box in the new issue's dialog, in px: taller than the tab's, as it is the
 *  dialog's one big field. */
const NEW_ISSUE_BOX_HEIGHT = 220;

interface NewIssue {
  title: string;
  body: string;
}

/** The fields of a new issue, its description in the tab's box. No upload here: nothing is written
 *  until the question's answer. */
function NewIssueFields({ value, onChange, error, busy, field, rendering }: PromptFields<NewIssue> & { rendering: TextRendering }) {
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
      <FieldGroup label="Description">
        <div className="issue-comment">
          <div className="issue-card">
            <div className="issue-card-edit">
              <TextBox
                label="Description"
                value={value.body}
                onChange={(body) => onChange((current) => ({ ...current, body }))}
                disabled={busy}
                writing={{ rendering, upload: undefined, accept: undefined }}
                height={NEW_ISSUE_BOX_HEIGHT}
              />
            </div>
          </div>
        </div>
      </FieldGroup>
    </>
  );
}

function IssueRow({
  issue,
  active,
  unread,
  onOpen,
  onMenu,
}: {
  issue: Issue;
  /** Its tab is the active editor tab. */
  active: boolean;
  /** The tracker created or changed it since its tab last showed it (`isUnread`). */
  unread: boolean;
  onOpen: (how: OpenEditor) => void;
  onMenu: (event: React.MouseEvent) => void;
}) {
  const detail =
    unread && issue.updatedAt !== issue.createdAt ? `updated ${dayOf(issue.updatedAt)}, opened by` : `opened ${dayOf(issue.createdAt)}, by`;
  return (
    <div
      className={`list-row issue-row two-line${active ? " active" : ""}`}
      title={[`#${issue.number} ${issue.title}`, ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(", ")}`] : [])].join("\n")}
      draggable
      onDragStart={(event) => event.dataTransfer.setData(ISSUE_DRAG_TYPE, String(issue.number))}
      onClick={() => onOpen({})}
      onDoubleClick={() => onOpen({ keep: true })}
      onContextMenu={onMenu}
    >
      <span className="list-main">
        <span className="list-label">{issue.title}</span>
        <span className="issue-detail-line">
          <span className="list-detail">
            #{issue.number} · {detail} {issue.author}
          </span>
          {unread && <span className="issue-mark" />}
        </span>
      </span>
      {issue.assignee === undefined ? (
        <span className="issue-person vacant" />
      ) : (
        <Person login={issue.assignee} avatar={issue.avatars[issue.assignee]} />
      )}
    </div>
  );
}

/**
 * The project's issues, on its tracker: a click opens one in the preview tab, a double click keeps
 * it, as the Explorer's files, and a drag onto a pane opens it there. All this writes to the
 * tracker is a new issue and a row's title or deletion; its tab changes the rest. The source is the
 * project's setting, so a worktree, which changes none, offers no button for it. An account is the
 * machine's, so every project sends the user to the Settings' Accounts while its tracker has none.
 */
export const IssueList = memo(function IssueList({
  resolved,
  shown,
  openIssue,
  onOpenFile,
  onOpenAccounts,
}: {
  resolved: ResolvedRef;
  shown: boolean;
  /** The active editor tab's issue — its row is marked. */
  openIssue: number | null;
  onOpenFile: (ref: ProjectRef, path: string, how?: OpenEditor) => void;
  onOpenAccounts: () => void;
}) {
  const { projectId, worktree } = resolved.ref;
  const [filter, setFilter] = useStoredJson(`issues-filter.${projectId}`, DEFAULT_ISSUE_FILTER);
  const { issues, source, tracker, noAccount, options, busy, reload, write } = useIssues(projectId, filter, shown);
  const seen = useIssuesSeen(projectId);
  // The open one is on screen, so read.
  const unread = (issue: Issue): boolean => issue.number !== openIssue && isUnread(issue, seen);
  const [title, setTitle] = useState("");
  const needle = title.trim().toLowerCase();
  const shownIssues = (issues ?? []).filter((issue) => issue.title.toLowerCase().includes(needle));
  const menu = useContextMenu<Issue>();
  const agents = useAgents();

  const askSource = async (): Promise<void> => {
    await prompt({
      title: "Issue source",
      detail: "Leave empty to show the issues of this repository itself.",
      confirmLabel: "Save",
      value: source ?? "",
      ready: () => true,
      render: singleField("Project or repository path"),
      submit: async (typed) => refusal(await window.tet.issues.setSource(projectId, typed)),
    });
  };

  const askNewIssue = async (): Promise<void> => {
    if (tracker === undefined) {
      return;
    }
    const rendering: TextRendering = {
      provider: tracker.provider,
      issueUrl: newIssueUrl(tracker.provider, tracker.url),
      loadImage: (source) => loadProjectIssueImage(projectId, source),
      openFile: (path) => onOpenFile(resolved.ref, path),
    };
    let created: number | undefined;
    await prompt<NewIssue>({
      title: "New issue",
      className: "new-issue-dialog",
      confirmLabel: "Create",
      value: { title: "", body: "" },
      ready: (value) => filled(value.title),
      render: (fields) => <NewIssueFields {...fields} rendering={rendering} />,
      submit: async ({ title: typed, body }) => {
        const result = await write(() => window.tet.issues.create(projectId, typed.trim(), body));
        if (result.ok) {
          created = result.number;
        }
        return refusal(result);
      },
    });
    if (created !== undefined) {
      onOpenFile(resolved.ref, issueFileName(created), { issue: created, keep: true });
    }
  };

  const askRename = (issue: Issue): Promise<void> =>
    askIssueTitle(issue.title, async (typed) => {
      const result = await window.tet.issues.update(projectId, issue.number, { title: typed });
      if (result.ok) {
        reload();
      }
      return refusal(result);
    });

  /** The list and, for an issue the list no longer shows too, every open tab read afresh. */
  const refresh = (): void => {
    reload();
    reloadIssueTabs(projectId);
  };

  const askDelete = async (issue: Issue): Promise<void> => {
    if (!(await confirmDeleteIssue(issue.number))) {
      return;
    }
    const result = await write(() => window.tet.issues.delete(projectId, issue.number));
    if (!result.ok) {
      notify("error", result.error);
      return;
    }
    issueGone(projectId, issue.number);
  };

  const menuEntries = (issue: Issue): ContextMenuEntry[] => [
    { label: "Open in Browser", run: () => void window.tet.shell.openUrl(issue.url) },
    SEPARATOR,
    {
      label: "Open in Agent",
      entries: issueAgentEntries(agents, (agentId) => void openIssueInAgent(resolved.ref, issue.number, agentId)),
    },
    SEPARATOR,
    { label: "Rename...", run: () => void askRename(issue) },
    { label: "Delete...", run: () => void askDelete(issue) },
  ];

  return (
    <div className={`lane-content${shown ? "" : " hidden"}`}>
      <Section
        title="ISSUES"
        count={issues?.length}
        busy={busy}
        actions={
          <>
            <IconButton title="Refresh" disabled={busy} onClick={refresh}>
              <SyncIcon />
            </IconButton>
            <IconButton
              title="Mark All as Read"
              disabled={busy || !(issues ?? []).some(unread)}
              onClick={() => void keepAllIssuesSeen(projectId)}
            >
              <ListCheckIcon />
            </IconButton>
            {worktree === undefined && (
              <IconButton title="Issue source..." onClick={() => void askSource()}>
                <LinkIcon />
              </IconButton>
            )}
            {noAccount && (
              <IconButton title="Add account..." onClick={onOpenAccounts}>
                <UserPlusIcon />
              </IconButton>
            )}
            <IconButton title="New Issue..." disabled={tracker === undefined} onClick={() => void askNewIssue()}>
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
                active={issue.number === openIssue}
                unread={unread(issue)}
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
