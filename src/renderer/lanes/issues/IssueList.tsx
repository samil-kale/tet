import { memo, useState } from "react";
import type { ProjectRef } from "../../../shared/types/project";
import { DEFAULT_ISSUE_FILTER, isUnread, type Issue, type TrackedRef } from "../../../shared/types/providers";
import { issueGone, linkTrackedSession, openTrackedTab, sendTrackedToAgent, type OpenEditor } from "../../editor/editor-tab";
import { reloadTrackedTabs } from "../../editor/tracked/tracked-views";
import { openProjectIssueLink } from "../../editor/tracked/tracked-views";
import { loadProjectTrackedImage } from "../../editor/tracked/tracked-views";
import { keepAllSeen, keepSeen, keepUnread, useSeen } from "../../editor/tracked/tracked-seen";
import { newIssueUrl } from "../../editor/tracked/tracked-text";
import { trackedSessionsOf, useWatchedSessions } from "../../editor/tracked/use-tracked-sessions";
import { trackedSessionEntry } from "../../editor/tracked/TrackedBar";
import { confirmDeleteIssue } from "../../editor/tracked/TrackedBar";
import { askTrackedTitle } from "../../editor/tracked/TrackedBar";
import { TextBox } from "../../editor/tracked/TextBox";
import type { TextRendering } from "../../editor/tracked/tracked-actions";
import { Person } from "../../editor/tracked/Person";
import { dayOf } from "../../editor/tracked/tracked-words";
import type { ResolvedRef } from "../../resolved-ref";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { filled, prompt, refusal, singleField, type PromptFields } from "../../ui/Dialog";
import { Checkbox, FieldGroup, TextField } from "../../ui/Field";
import { FilterField } from "../../ui/FilterField";
import { IconButton } from "../../ui/IconButton";
import { LinkIcon, ListCheckIcon, PlusIcon, SyncIcon, UserPlusIcon } from "../../ui/icons";
import { useStoredJson } from "../../ui/layout-storage";
import { notify } from "../../ui/Notices";
import { SESSION_TAB_DRAG_TYPE, TRACKED_DRAG_TYPE } from "../../tabs/pane-layout";
import { Section } from "../../ui/Section";
import { useAgents } from "../../ui/use-agents";
import { useDropTarget } from "../../ui/use-drop-target";
import { RowSpacer, TWO_LINE_ROW_HEIGHT, useWindowedRows } from "../../ui/use-windowed-rows";
import { IssueFilterBar } from "./IssueFilterBar";
import { useTrackedRows } from "../../editor/tracked/use-tracked-rows";
import { useScrollMore } from "../../ui/use-scroll-more";
import { useIssues } from "./use-issues";

/** The project's issue of this number, as the tab and session calls name it. */
function trackedOf(number: number): TrackedRef {
  return { kind: "issue", number };
}

/** The description's box in the new issue's dialog, in px: taller than the tab's, as it is the
 *  dialog's one big field. */
const NEW_ISSUE_BOX_HEIGHT = 220;

interface NewIssue {
  title: string;
  body: string;
  confidential: boolean;
}

/** The fields of a new issue, its description in the tab's box. No upload here: nothing is written
 *  until the question's answer. The confidential checkbox is offered where the tracker has it. */
function NewIssueFields({
  value,
  onChange,
  error,
  busy,
  field,
  rendering,
  confidentialIssues,
}: PromptFields<NewIssue> & { rendering: TextRendering; confidentialIssues: boolean }) {
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
        <div className="tracked-comment">
          <div className="tracked-card">
            <div className="tracked-card-edit">
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
      {confidentialIssues && (
        <Checkbox
          label="Make this issue confidential"
          checked={value.confidential}
          onChange={(confidential) => onChange((current) => ({ ...current, confidential }))}
          disabled={busy}
        />
      )}
    </>
  );
}

function IssueRow({
  issue,
  active,
  unread,
  dropTarget,
  dropProps,
  onOpen,
  onMenu,
}: {
  issue: Issue;
  /** Its tab is the focused pane's active tab. */
  active: boolean;
  /** The tracker created or changed it since its tab last showed it (`isUnread`). */
  unread: boolean;
  /** A tab whose session it would link is held over it. */
  dropTarget: boolean;
  dropProps: React.HTMLAttributes<HTMLElement>;
  onOpen: (how: OpenEditor) => void;
  onMenu: (event: React.MouseEvent) => void;
}) {
  return (
    <div
      {...dropProps}
      className={`list-row tracked-row two-line${active ? " active" : ""}${dropTarget ? " drop-target" : ""}`}
      title={[`#${issue.number} ${issue.title}`, ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(", ")}`] : [])].join("\n")}
      draggable
      onDragStart={(event) => event.dataTransfer.setData(TRACKED_DRAG_TYPE, JSON.stringify(trackedOf(issue.number)))}
      onClick={() => onOpen({})}
      onDoubleClick={() => onOpen({ keep: true })}
      onContextMenu={onMenu}
    >
      <span className="list-main">
        <span className="list-label">{issue.title}</span>
        <span className="tracked-detail-line">
          <span className="list-detail">
            #{issue.number} · opened {dayOf(issue.createdAt)}, by {issue.author}
          </span>
          {unread && <span className="row-dot" />}
        </span>
      </span>
      {issue.assignee === undefined ? (
        <span className="user-avatar vacant" />
      ) : (
        <Person login={issue.assignee} avatar={issue.avatars[issue.assignee]} />
      )}
    </div>
  );
}

/**
 * The project's issues, on its tracker: a click opens one in the preview tab, a double click keeps
 * it, as the Explorer's files, and a drag onto a pane opens it there. All this writes to the
 * tracker is a new issue and a row's title or deletion; its tab changes the rest. A tab with a session
 * dropped on a row is linked to its issue, as `tet-ctl issues-link-session` does. The source is the
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
  /** The issue of the focused pane's active tab — its row is marked. */
  openIssue: number | null;
  onOpenFile: (ref: ProjectRef, path: string, how?: OpenEditor) => void;
  onOpenAccounts: () => void;
}) {
  const { projectId, worktree } = resolved.ref;
  const [filter, setFilter] = useStoredJson(`issues-filter.${projectId}`, DEFAULT_ISSUE_FILTER);
  const [title, setTitle] = useState("");
  const { items: issues, result, total, rowsKey, more, options, busy, reload, write } = useIssues(projectId, filter, title, shown);
  const { source, tracker } = result ?? {};
  const seen = useSeen("issue", projectId);
  const unread = (issue: Issue): boolean => isUnread(issue, seen);
  // Keyed by the page count too: the rows a page more brings come as they are, the tracker added none.
  const shownRows = useTrackedRows(issues, rowsKey ?? {});
  const scroller = useScrollMore(more);
  // Not while a row unfolds or folds away: it is then no fixed height.
  const windowing = useWindowedRows(
    scroller.ref,
    shownRows.length,
    "--two-line-row-height",
    TWO_LINE_ROW_HEIGHT,
    !shownRows.some((row) => row.entering || row.leaving),
  );
  const menu = useContextMenu<Issue>();
  const agents = useAgents();
  // Read by the row's menu alone, when it opens.
  useWatchedSessions("issue", projectId);
  const issueDrop = useDropTarget(SESSION_TAB_DRAG_TYPE, (tabId, number: number) => {
    void linkTrackedSession(resolved.ref, tabId, trackedOf(number), (linked) => `Issue #${linked}`);
  });

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
      loadImage: (image) => loadProjectTrackedImage(projectId, "issue", image),
      openFile: (path) => onOpenFile(resolved.ref, path),
      openLink: (url) => void openProjectIssueLink(projectId, url),
    };
    let created: number | undefined;
    await prompt<NewIssue>({
      title: "New issue",
      className: "new-issue-dialog",
      confirmLabel: "Create",
      value: { title: "", body: "", confidential: false },
      ready: (value) => filled(value.title),
      render: (fields) => <NewIssueFields {...fields} rendering={rendering} confidentialIssues={tracker.confidentialIssues} />,
      submit: async ({ title: typed, body, confidential }) => {
        const result = await write(() => window.tet.issues.create(projectId, typed.trim(), body, confidential));
        if (result.ok) {
          created = result.number;
        }
        return refusal(result);
      },
    });
    if (created !== undefined) {
      openTrackedTab(onOpenFile, resolved.ref, trackedOf(created), { keep: true });
    }
  };

  const askRename = (issue: Issue): Promise<void> =>
    askTrackedTitle(issue.title, async (typed) => {
      const result = await window.tet.tracked.update(projectId, trackedOf(issue.number), { title: typed });
      if (result.ok) {
        reload();
      }
      return refusal(result);
    });

  /** The list and, for an issue the list no longer shows too, every open tab read afresh. */
  const refresh = (): void => {
    reload();
    reloadTrackedTabs("issue", projectId);
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

  const menuEntries = (issue: Issue): ContextMenuEntry[] => {
    // A closed issue is never unread (`isUnread`), so it has nothing to mark.
    const readEntries: ContextMenuEntry[] = issue.open
      ? [
          SEPARATOR,
          unread(issue)
            ? { label: "Mark as Read", run: () => keepSeen(projectId, trackedOf(issue.number), issue.updatedAt) }
            : { label: "Mark as Unread", run: () => keepUnread(projectId, trackedOf(issue.number), issue.updatedAt) },
        ]
      : [];
    return [
      { label: "Open in Browser", run: () => void window.tet.shell.openUrl(issue.url) },
      SEPARATOR,
      trackedSessionEntry(
        trackedSessionsOf("issue", projectId)[issue.number],
        agents,
        (agentId) => void sendTrackedToAgent(resolved.ref, trackedOf(issue.number), agentId),
      ),
      ...readEntries,
      SEPARATOR,
      { label: "Rename...", run: () => void askRename(issue) },
      { label: "Delete...", run: () => void askDelete(issue) },
    ];
  };

  return (
    <div className={`lane-content${shown ? "" : " hidden"}`}>
      <Section
        title="Issues"
        count={total}
        busy={busy}
        actions={
          <>
            <IconButton title="Refresh" disabled={busy} onClick={refresh}>
              <SyncIcon />
            </IconButton>
            <IconButton
              title="Mark All as Read"
              disabled={busy || !(issues ?? []).some(unread)}
              onClick={() => void keepAllSeen("issue", projectId)}
            >
              <ListCheckIcon />
            </IconButton>
            {worktree === undefined && (
              <IconButton title="Issue source..." onClick={() => void askSource()}>
                <LinkIcon />
              </IconButton>
            )}
            {result?.noAccount === true && (
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
          <div className="tree" ref={scroller.ref} onScroll={scroller.onScroll}>
            <RowSpacer height={windowing.before} />
            {shownRows.slice(windowing.start, windowing.end).map(({ item: issue, entering, leaving }) => (
              <div key={issue.number} className={`tracked-item${entering ? " entering" : ""}${leaving ? " leaving" : ""}`}>
                <IssueRow
                  issue={issue}
                  active={issue.number === openIssue}
                  unread={unread(issue)}
                  dropTarget={issueDrop.over === issue.number}
                  dropProps={issueDrop.dropPropsOf(issue.number)}
                  onOpen={(how) => openTrackedTab(onOpenFile, resolved.ref, trackedOf(issue.number), how)}
                  onMenu={(event) => menu.open(event, issue)}
                />
              </div>
            ))}
            <RowSpacer height={windowing.after} />
          </div>
        </div>
        {menu.render(menuEntries)}
      </Section>
    </div>
  );
});
