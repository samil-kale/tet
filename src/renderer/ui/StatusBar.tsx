import { memo } from "react";
import type { Project } from "../../shared/types/project";
import type { Lane } from "../../shared/types/settings";
import { shortcutLabel } from "../shortcuts";
import { ArchiveIcon, BellIcon, BranchIcon, ProjectsIcon } from "./icons";
import { toggleCenter, useCenterOpen, useNoticeList } from "./Notices";

interface StatusBarProps {
  /** The active repository's or worktree's project; absent while none is open. */
  project: Project | undefined;
  /** Its branch, or the short commit id while detached; absent while none is open. */
  branch: string | undefined;
  /** Its uncommitted changes, by the branch. */
  changesCount: number;
  /** How many of its tabs are taken off the strip, their sessions kept. */
  archivedCount: number;
  /** A field's click opens the lane it names. */
  onSelectLane: (lane: Lane) => void;
}

/** The window's bottom edge (VS Code's status bar): the active repository or worktree, its
 *  branch with its change count, and its archived tab count, each opening its lane; at the right
 *  edge the bell of the notification center. Its icons read smaller than the rest of the app's. */
export const StatusBar = memo(function StatusBar({ project, branch, changesCount, archivedCount, onSelectLane }: StatusBarProps) {
  const notices = useNoticeList();
  const centerOpen = useCenterOpen();
  const unread = notices.filter((notice) => !notice.read).length;
  const bellTitle = centerOpen
    ? "Hide Notifications"
    : unread > 0
      ? `${unread} New Notification${unread === 1 ? "" : "s"}`
      : notices.length === 0
        ? "No Notifications"
        : "Show Notifications";
  return (
    <div className="status-bar">
      {project && (
        <button
          type="button"
          className="status-bar-item"
          title={`Projects (${shortcutLabel("toggleProjects")})`}
          onClick={() => onSelectLane("projects")}
        >
          <ProjectsIcon className="tree-icon" />
          {project.name}
        </button>
      )}
      <button
        type="button"
        className="status-bar-item"
        title={`Archive (${shortcutLabel("toggleArchive")})`}
        onClick={() => onSelectLane("archive")}
      >
        <ArchiveIcon className="tree-icon" />
        archive: {archivedCount}
      </button>
      {branch && (
        <button type="button" className="status-bar-item" title={`Git (${shortcutLabel("toggleGit")})`} onClick={() => onSelectLane("git")}>
          <BranchIcon className="tree-icon" />
          {branch}: {changesCount}
        </button>
      )}
      <button
        type="button"
        className={`status-bar-item status-bar-bell${unread > 0 ? " unread" : ""}`}
        title={bellTitle}
        onClick={toggleCenter}
      >
        <BellIcon className="tree-icon" />
      </button>
    </div>
  );
});
