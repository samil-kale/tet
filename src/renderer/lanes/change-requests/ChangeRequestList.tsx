import { memo, useState } from "react";
import type { ProjectRef } from "../../../shared/types/project";
import {
  DEFAULT_CHANGE_REQUEST_FILTER,
  isChangeRequestUnread,
  type ChangeRequestKind,
  type ChangeRequestRow as Row,
} from "../../../shared/types/providers";
import { openChangeRequestTab, sendIssueToAgent, type OpenEditor } from "../../editor/editor-tab";
import { reloadIssueTabs } from "../../editor/editor-views";
import { dayOf, issueSessionEntry, Person } from "../../editor/IssueView";
import { keepAllSeen, keepSeen, keepUnread, useSeen } from "../../editor/tracked-seen";
import { trackedSessionsOf, useWatchedSessions } from "../../editor/use-tracked-sessions";
import type { ResolvedRef } from "../../resolved-ref";
import { CHANGE_REQUEST_DRAG_TYPE, SESSION_TAB_DRAG_TYPE } from "../../tabs/pane-layout";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { FilterField } from "../../ui/FilterField";
import { IconButton } from "../../ui/IconButton";
import { ListCheckIcon, SyncIcon, UserPlusIcon } from "../../ui/icons";
import { useStoredJson } from "../../ui/layout-storage";
import { notify } from "../../ui/Notices";
import { Section } from "../../ui/Section";
import { useAgents } from "../../ui/use-agents";
import { useDropTarget } from "../../ui/use-drop-target";
import { useIssueRows } from "../../ui/use-issue-rows";
import { useScrollMore } from "../../ui/use-scroll-more";
import { ChangeRequestFilterBar } from "./ChangeRequestFilterBar";
import { useChangeRequests } from "./use-change-requests";

/** The section's title: the host's word for them, "Pull Requests" or "Merge Requests", until it is
 *  known both. */
function titleOf(kind: ChangeRequestKind | undefined): string {
  return kind ? `${kind.noun.replace(/\b\w/g, (letter) => letter.toUpperCase())}s` : "Pull and Merge Requests";
}

function ChangeRequestRow({
  row,
  kind,
  active,
  unread,
  dropTarget,
  dropProps,
  onOpen,
  onMenu,
}: {
  row: Row;
  kind: ChangeRequestKind | undefined;
  /** Its tab is the focused pane's active tab. */
  active: boolean;
  /** The host created or changed it, or its checks failed, since its tab last showed it. */
  unread: boolean;
  /** A tab whose session it would link is held over it. */
  dropTarget: boolean;
  dropProps: React.HTMLAttributes<HTMLElement>;
  onOpen: (how: OpenEditor) => void;
  onMenu: (event: React.MouseEvent) => void;
}) {
  const name = `${kind?.prefix ?? "#"}${row.number}`;
  const failed = row.open && row.checks === "failed";
  return (
    <div
      {...dropProps}
      className={`list-row issue-row two-line${active ? " active" : ""}${dropTarget ? " drop-target" : ""}`}
      title={[
        `${name} ${row.title}`,
        ...(row.labels.length > 0 ? [`Labels: ${row.labels.join(", ")}`] : []),
        ...(failed ? [`${kind?.checks ?? "checks"} failed`] : []),
      ].join("\n")}
      draggable
      onDragStart={(event) => event.dataTransfer.setData(CHANGE_REQUEST_DRAG_TYPE, String(row.number))}
      onClick={() => onOpen({})}
      onDoubleClick={() => onOpen({ keep: true })}
      onContextMenu={onMenu}
    >
      <span className="list-main">
        <span className="list-label">{row.title}</span>
        <span className="issue-detail-line">
          <span className="list-detail">
            {name}
            {row.open && row.draft && " · draft"} · opened {dayOf(row.createdAt)}, by {row.author}
          </span>
          {failed && <span className="issue-mark failed" />}
          {unread && <span className="issue-mark" />}
        </span>
      </span>
      {row.assignee === undefined ? (
        <span className="issue-person vacant" />
      ) : (
        <Person login={row.assignee} avatar={row.avatars[row.assignee]} />
      )}
    </div>
  );
}

/**
 * The pull or merge requests of the project's repository, on its own remote, as the Issues section
 * lists its issues: a click opens one in the preview tab, a double click keeps it, a drag onto a pane
 * opens it there, and a tab with a session dropped on a row is linked to it. A row marks failed checks
 * in the error colour beside the unread dot. Nothing is made or deleted here: a change request is
 * opened from Branches, and changed in its tab.
 */
export const ChangeRequestList = memo(function ChangeRequestList({
  resolved,
  shown,
  openChangeRequest,
  onOpenFile,
  onOpenAccounts,
}: {
  resolved: ResolvedRef;
  shown: boolean;
  /** The change request of the focused pane's active tab — its row is marked. */
  openChangeRequest: number | null;
  onOpenFile: (ref: ProjectRef, path: string, how?: OpenEditor) => void;
  onOpenAccounts: () => void;
}) {
  const { projectId } = resolved.ref;
  const [filter, setFilter] = useStoredJson(`change-requests-filter.${projectId}`, DEFAULT_CHANGE_REQUEST_FILTER);
  const [title, setTitle] = useState("");
  const { changeRequests, total, read, more, kind, noAccount, options, busy, reload } = useChangeRequests(projectId, filter, title, shown);
  const seen = useSeen("change-request", projectId);
  const unread = (row: Row): boolean => isChangeRequestUnread(row, seen);
  // Keyed by the page count too, as the Issues section's rows.
  const shownRows = useIssueRows(changeRequests, read ?? {});
  const scroller = useScrollMore(more);
  const menu = useContextMenu<Row>();
  const agents = useAgents();
  // Read by the row's menu alone, when it opens.
  useWatchedSessions("change-request", projectId);
  const rowDrop = useDropTarget(SESSION_TAB_DRAG_TYPE, (tabId, number: number) => {
    void window.tet.tabs.linkChangeRequest(resolved.ref, tabId, number).then((result) => {
      if (result.ok) {
        const { movedFrom, replacedSession } = result;
        const prefix = kind?.prefix ?? "#";
        const linked =
          movedFrom === undefined
            ? `Session linked to ${prefix}${number}`
            : `Session moved from ${prefix}${movedFrom} to ${prefix}${number}`;
        notify("info", replacedSession ? `${linked} in place of its previous one` : linked);
      } else {
        notify("error", result.error);
      }
    });
  });

  /** The list and, for one the list no longer shows too, every open tab read afresh. */
  const refresh = (): void => {
    reload();
    reloadIssueTabs(projectId, "change-request");
  };

  const menuEntries = (row: Row): ContextMenuEntry[] => {
    const readEntries: ContextMenuEntry[] = row.open
      ? [
          SEPARATOR,
          unread(row)
            ? {
                label: "Mark as Read",
                run: () => keepSeen("change-request", projectId, row.number, row.updatedAt, row.checks === "failed"),
              }
            : { label: "Mark as Unread", run: () => keepUnread("change-request", projectId, row.number, row.updatedAt) },
        ]
      : [];
    return [
      { label: "Open in Browser", run: () => void window.tet.shell.openUrl(row.url) },
      SEPARATOR,
      issueSessionEntry(
        trackedSessionsOf("change-request", projectId)[row.number],
        agents,
        (agentId) => void sendIssueToAgent(resolved.ref, row.number, agentId, "change-request"),
      ),
      ...readEntries,
    ];
  };

  return (
    <div className={`lane-content${shown ? "" : " hidden"}`}>
      <Section
        title={titleOf(kind)}
        count={total}
        busy={busy}
        actions={
          <>
            <IconButton title="Refresh" disabled={busy} onClick={refresh}>
              <SyncIcon />
            </IconButton>
            <IconButton
              title="Mark All as Read"
              disabled={busy || !(changeRequests ?? []).some(unread)}
              onClick={() => void keepAllSeen("change-request", projectId)}
            >
              <ListCheckIcon />
            </IconButton>
            {noAccount && (
              <IconButton title="Add account..." onClick={onOpenAccounts}>
                <UserPlusIcon />
              </IconButton>
            )}
          </>
        }
      >
        <div className="filter-list">
          <FilterField placeholder={`Filter ${titleOf(kind).toLowerCase()}...`} value={title} onChange={setTitle} />
          <ChangeRequestFilterBar filter={filter} options={options} onChange={setFilter} />
          <div className="tree" ref={scroller.ref} onScroll={scroller.onScroll}>
            {shownRows.map(({ issue: row, entering, leaving }) => (
              <div key={row.number} className={`issue-item${entering ? " entering" : ""}${leaving ? " leaving" : ""}`}>
                <ChangeRequestRow
                  row={row}
                  kind={kind}
                  active={row.number === openChangeRequest}
                  unread={unread(row)}
                  dropTarget={rowDrop.over === row.number}
                  dropProps={rowDrop.dropPropsOf(row.number)}
                  onOpen={(how) => openChangeRequestTab(onOpenFile, resolved.ref, row.number, how)}
                  onMenu={(event) => menu.open(event, row)}
                />
              </div>
            ))}
          </div>
        </div>
        {menu.render(menuEntries)}
      </Section>
    </div>
  );
});
