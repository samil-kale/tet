import { projectRefKey, projectRef, projectRefsOf } from "../../shared/types";
import type { ProjectRef, Project } from "../../shared/types";
import { layoutKey } from "../ui/layout-storage";

/** The repository or worktree in front (its `projectRefKey`), in layout storage: which one is in
 *  front describes the window. */
const ACTIVE_PROJECT_KEY = layoutKey("active-project");

/** The repository or worktree in front at startup: the one in front when tet last closed, while
 *  still open, else the first project's repository. */
export function activeAtStart(projects: readonly Project[]): string | null {
  const remembered = localStorage.getItem(ACTIVE_PROJECT_KEY);
  const open = projects.flatMap((project) => projectRefsOf(project).map(projectRefKey));
  const first = projects[0];
  return open.find((key) => key === remembered) ?? (first ? projectRefKey(projectRef(first.id)) : null);
}

/** Remembers the repository or worktree in front for the next start; none leaves the last one
 *  standing. */
export function rememberActive(key: string | null): void {
  if (key !== null) {
    localStorage.setItem(ACTIVE_PROJECT_KEY, key);
  }
}

/**
 * The repository or worktree in front after `projects:changed`, from the one in front before
 * (`current`): the one the user just opened (`show`) comes to the front. A removed repository or
 * worktree in front gives way to its project's repository when it was a worktree of a project still
 * open, else to the first project's.
 */
export function activeAfterChange(
  current: string | null,
  after: readonly Project[],
  removed: readonly ProjectRef[] | undefined,
  show: ProjectRef | undefined
): string | null {
  if (show !== undefined) {
    return projectRefKey(show);
  }
  const gone = removed?.find((ref) => projectRefKey(ref) === current);
  if (gone === undefined) {
    return current;
  }
  const main = gone.worktree === undefined ? undefined : after.find((project) => project.id === gone.projectId);
  const next = main ?? after[0];
  return next ? projectRefKey(projectRef(next.id)) : null;
}
