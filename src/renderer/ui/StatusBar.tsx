import { memo } from "react";
import type { Project } from "../../shared/types/project";
import type { Lane } from "../../shared/types/settings";
import { ArchiveIcon, BranchIcon, ProjectsIcon } from "./icons";

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
 *  branch with its change count, and its archived tab count, each opening its lane. Its icons
 *  read smaller than the rest of the app's. */
export const StatusBar = memo(function StatusBar({ project, branch, changesCount, archivedCount, onSelectLane }: StatusBarProps) {
  return (
    <div className="status-bar">
      {project && (
        <button type="button" className="status-bar-item" title="Show projects" onClick={() => onSelectLane("projects")}>
          <ProjectsIcon className="tree-icon" />
          {project.name}
        </button>
      )}
      <button type="button" className="status-bar-item" title="Show archive" onClick={() => onSelectLane("archive")}>
        <ArchiveIcon className="tree-icon" />
        archived: {archivedCount}
      </button>
      {branch && (
        <button type="button" className="status-bar-item" title="Show git" onClick={() => onSelectLane("git")}>
          <BranchIcon className="tree-icon" />
          {branch}: {changesCount}
        </button>
      )}
    </div>
  );
});
