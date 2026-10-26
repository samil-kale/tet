import { memo, useCallback, useState } from "react";
import type { Project } from "../../shared/types/project";
import { shortcutLabel } from "../shortcuts";
import { ArchiveIcon, BellIcon, BranchIcon, ProjectsIcon } from "./icons";
import { MARK_ORDER, removable, toggleCenter, useNoticeList } from "./Notices";
import { StatusList, type StatusListItem } from "./StatusList";
import { TabMark } from "./TabMark";

interface StatusBarProps {
  /** The active repository's or worktree's project; absent while none is open. */
  project: Project | undefined;
  /** Every project, as its click lists them. */
  projects: StatusListItem[];
  /** A project's click in that list opens its repository. */
  onSelectProject: (projectId: string) => void;
  /** Its tabs in the strip's order. */
  sessions: StatusListItem[];
  /** The tab the focused pane shows; absent while it has none. */
  activeSessionId: string | undefined;
  /** A session's click shows its tab. */
  onSelectSession: (tabId: string) => void;
  /** Its branch, or the short commit id while detached; absent while none is open. */
  branch: string | undefined;
  /** Its uncommitted changes, by the branch. */
  changesCount: number;
  /** Its archived sessions, as the archive's click lists them. */
  archived: StatusListItem[];
  /** An archived session's click in that list reopens its tab. */
  onSelectArchived: (tabId: string) => void;
  /** Its local branches in the branch tree's order, as the branch's click lists them. */
  branches: StatusListItem[];
  /** A branch's click in that list switches to it. */
  onSelectBranch: (name: string) => void;
}

/** The window's bottom edge (VS Code's status bar): the active repository or worktree with its
 *  active session, whose clicks list the projects and the sessions to pick from, and its branch with its change count, whose click lists the
 *  local branches; at the right edge the button of the notification center. Its icons read smaller than the rest of the app's. */
export const StatusBar = memo(function StatusBar({
  project,
  projects,
  onSelectProject,
  sessions,
  activeSessionId,
  onSelectSession,
  branch,
  changesCount,
  archived,
  onSelectArchived,
  branches,
  onSelectBranch,
}: StatusBarProps) {
  const notices = useNoticeList();
  /** The list shown, if any: one at a time, as they share their place. */
  const [openList, setOpenList] = useState<"projects" | "sessions" | "branches" | "archive" | null>(null);
  const closeList = useCallback(() => setOpenList(null), []);
  const toggleList = (list: "projects" | "sessions" | "branches" | "archive"): void => setOpenList((open) => (open === list ? null : list));
  const active = sessions.find((session) => session.id === activeSessionId);
  // An agent's notice stands in the center until its tab's state ends, read or not.
  const highlighted = notices.some((notice) => !notice.read || !removable(notice));
  const marks = MARK_ORDER.filter((mark) => notices.some((notice) => notice.mark === mark));
  return (
    <>
      <div className="status-bar">
        {project && (
          <button type="button" className="status-bar-item status-bar-projects" title="Projects" onClick={() => toggleList("projects")}>
            <ProjectsIcon className="tree-icon" />
            {project.name}
          </button>
        )}
        {active && (
          <button type="button" className="status-bar-item status-bar-sessions" title="Sessions" onClick={() => toggleList("sessions")}>
            {active.icon}
            <span className="status-bar-session">{active.label}</span>
          </button>
        )}
        {branch && (
          <button type="button" className="status-bar-item status-bar-branches" title="Branches" onClick={() => toggleList("branches")}>
            <BranchIcon className="tree-icon" />
            {branch}: {changesCount}
          </button>
        )}
        {project && (
          <button type="button" className="status-bar-item status-bar-archive" title="Archive" onClick={() => toggleList("archive")}>
            <ArchiveIcon className="tree-icon" />
            archive: {archived.length}
          </button>
        )}
        <button
          type="button"
          className={`status-bar-item status-bar-notices${highlighted ? " highlighted" : ""}`}
          title={`Notifications (${shortcutLabel("toggleNotices")})`}
          onClick={toggleCenter}
        >
          {marks.map((mark) => (
            <TabMark key={mark} kind={mark} />
          ))}
          <BellIcon className="tree-icon" />
        </button>
      </div>
      {openList === "projects" && (
        <StatusList
          title="Projects"
          items={projects}
          activeId={project?.id}
          trigger="status-bar-projects"
          onSelect={onSelectProject}
          onClose={closeList}
        />
      )}
      {openList === "sessions" && (
        <StatusList
          title="Sessions"
          items={sessions}
          activeId={activeSessionId}
          trigger="status-bar-sessions"
          onSelect={onSelectSession}
          onClose={closeList}
        />
      )}
      {openList === "archive" && (
        <StatusList
          title="Archive"
          items={archived}
          activeId={undefined}
          trigger="status-bar-archive"
          onSelect={onSelectArchived}
          onClose={closeList}
        />
      )}
      {openList === "branches" && (
        <StatusList
          title="Branches"
          items={branches}
          activeId={branch}
          trigger="status-bar-branches"
          onSelect={onSelectBranch}
          onClose={closeList}
        />
      )}
    </>
  );
});
