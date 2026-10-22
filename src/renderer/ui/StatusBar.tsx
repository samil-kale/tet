import { memo } from "react";
import type { Project } from "../../shared/types/project";
import type { Lane } from "../../shared/types/settings";
import { shortcutLabel } from "../shortcuts";
import { ArchiveIcon, BellIcon, BranchIcon, ProjectsIcon } from "./icons";
import { MARK_ORDER, removable, toggleCenter, useNoticeList } from "./Notices";
import { TabMark } from "./TabMark";

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
 *  edge the button of the notification center. Its icons read smaller than the rest of the app's. */
export const StatusBar = memo(function StatusBar({ project, branch, changesCount, archivedCount, onSelectLane }: StatusBarProps) {
  const notices = useNoticeList();
  // An agent's notice stands in the center until its tab's state ends, read or not.
  const highlighted = notices.some((notice) => !notice.read || !removable(notice));
  const marks = MARK_ORDER.filter((mark) => notices.some((notice) => notice.mark === mark));
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
  );
});
