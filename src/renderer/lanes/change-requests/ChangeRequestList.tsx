import { memo, useState } from "react";
import type { ProjectRef } from "../../../shared/types/project";
import {
  changeRequestName,
  DEFAULT_CHANGE_REQUEST_FILTER,
  isChangeRequestUnread,
  titleCased,
  type ChangeRequestKind,
  type ChangeRequestRow as Row,
  type TrackedRef,
} from "../../../shared/types/providers";
import { linkTrackedSession, openTrackedTab, sendTrackedToAgent, type OpenEditor } from "../../editor/editor-tab";
import { reloadTrackedTabs } from "../../editor/tracked/tracked-views";
import { trackedSessionEntry } from "../../editor/tracked/TrackedBar";
import { Person } from "../../editor/tracked/Person";
import { dayOf } from "../../editor/tracked/tracked-words";
import { keepAllSeen, keepSeen, keepUnread, useSeen } from "../../editor/tracked/tracked-seen";
import { trackedSessionsOf, useWatchedSessions } from "../../editor/tracked/use-tracked-sessions";
import type { ResolvedRef } from "../../resolved-ref";
import { SESSION_TAB_DRAG_TYPE, TRACKED_DRAG_TYPE } from "../../tabs/pane-layout";
import { SEPARATOR, useContextMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { FilterField } from "../../ui/FilterField";
import { IconButton } from "../../ui/IconButton";
import { ListCheckIcon, SyncIcon, UserPlusIcon } from "../../ui/icons";
import { useStoredJson } from "../../ui/layout-storage";
import { Section } from "../../ui/Section";
import { useAgents } from "../../ui/use-agents";
import { useDropTarget } from "../../ui/use-drop-target";
import { useScrollMore } from "../../ui/use-scroll-more";
import { useTrackedRows } from "../../editor/tracked/use-tracked-rows";
import { ChangeRequestFilterBar } from "./ChangeRequestFilterBar";
import { useChangeRequests } from "./use-change-requests";

/** The project's change request of this number, as the tab and session calls name it. */
function trackedOf(number: number): TrackedRef {
  return { kind: "change-request", number };
}

/** The section's title: the host's word for them, "Pull Requests" or "Merge Requests", until it is
 *  known both. */
function titleOf(kind: ChangeRequestKind | undefined): string {
  return kind ? `${titleCased(kind.noun)}s` : "Pull and Merge Requests";
}

/** How a row and a notice name one before the host's word for it is known. */
function nameOf(kind: ChangeRequestKind | undefined, number: number): string {
  return kind ? changeRequestName(kind, number) : `#${number}`;
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
  const name = nameOf(kind, row.number);
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
      onDragStart={(event) => event.dataTransfer.setData(TRACKED_DRAG_TYPE, JSON.stringify(trackedOf(row.number)))}
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
  const { items, result, total, rowsKey, more, options, busy, reload } = useChangeRequests(projectId, filter, title, shown);
  const kind = result?.kind;
  const seen = useSeen("change-request", projectId);
  const unread = (row: Row): boolean => isChangeRequestUnread(row, seen);
  // Keyed by the page count too, as the Issues section's rows.
  const shownRows = useTrackedRows(items, rowsKey ?? {});
  const scroller = useScrollMore(more);
  const menu = useContextMenu<Row>();
  const agents = useAgents();
  // Read by the row's menu alone, when it opens.
  useWatchedSessions("change-request", projectId);
  const rowDrop = useDropTarget(SESSION_TAB_DRAG_TYPE, (tabId, number: number) => {
    void linkTrackedSession(resolved.ref, tabId, trackedOf(number), (linked) => nameOf(kind, linked));
  });

  /** The list and, for one the list no longer shows too, every open tab read afresh. */
  const refresh = (): void => {
    reload();
    reloadTrackedTabs("change-request", projectId);
  };

  const menuEntries = (row: Row): ContextMenuEntry[] => {
    const readEntries: ContextMenuEntry[] = row.open
      ? [
          SEPARATOR,
          unread(row)
            ? { label: "Mark as Read", run: () => keepSeen(projectId, trackedOf(row.number), row.updatedAt, row.checks === "failed") }
            : { label: "Mark as Unread", run: () => keepUnread(projectId, trackedOf(row.number), row.updatedAt) },
        ]
      : [];
    return [
      { label: "Open in Browser", run: () => void window.tet.shell.openUrl(row.url) },
      SEPARATOR,
      trackedSessionEntry(
        trackedSessionsOf("change-request", projectId)[row.number],
        agents,
        (agentId) => void sendTrackedToAgent(resolved.ref, trackedOf(row.number), agentId),
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
              disabled={busy || !(items ?? []).some(unread)}
              onClick={() => void keepAllSeen("change-request", projectId)}
            >
              <ListCheckIcon />
            </IconButton>
            {result?.noAccount === true && (
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
            {shownRows.map(({ item: row, entering, leaving }) => (
              <div key={row.number} className={`issue-item${entering ? " entering" : ""}${leaving ? " leaving" : ""}`}>
                <ChangeRequestRow
                  row={row}
                  kind={kind}
                  active={row.number === openChangeRequest}
                  unread={unread(row)}
                  dropTarget={rowDrop.over === row.number}
                  dropProps={rowDrop.dropPropsOf(row.number)}
                  onOpen={(how) => openTrackedTab(onOpenFile, resolved.ref, trackedOf(row.number), how)}
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
