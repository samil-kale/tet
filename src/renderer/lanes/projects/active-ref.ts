import { projectRef, refKeyOf, projectRefsOf } from "../../../shared/types/project";
import type { Project, ProjectRef } from "../../../shared/types/project";
import { layoutKey } from "../../ui/layout-storage";

/** The active repository or worktree (its `refKey`), in layout storage: which one is active
 *  describes the window. */
const STORAGE_KEY = layoutKey("active-ref");

/** The active repository or worktree at startup: the one active when TET last closed, while
 *  still open, else the first project's repository. */
export function activeAtStart(projects: readonly Project[]): string | null {
  const remembered = localStorage.getItem(STORAGE_KEY);
  const open = projects.flatMap((project) => projectRefsOf(project).map(refKeyOf));
  const first = projects[0];
  return open.find((candidate) => candidate === remembered) ?? (first ? refKeyOf(projectRef(first.id)) : null);
}

/** Remembers the active repository or worktree for the next start; none leaves the last one
 *  standing. */
export function rememberActive(active: string | null): void {
  if (active !== null) {
    localStorage.setItem(STORAGE_KEY, active);
  }
}

/**
 * The active repository or worktree after `projects:changed`, from the one active before
 * (`current`): the one the user just opened (`show`) becomes active. A removed active repository or
 * worktree gives way to its project's repository when it was a worktree of a project still
 * open, else to the first project's.
 */
export function activeAfterChange(
  current: string | null,
  after: readonly Project[],
  removed: readonly ProjectRef[] | undefined,
  show: ProjectRef | undefined
): string | null {
  if (show !== undefined) {
    return refKeyOf(show);
  }
  const gone = removed?.find((ref) => refKeyOf(ref) === current);
  if (gone === undefined) {
    return current;
  }
  const main = gone.worktree === undefined ? undefined : after.find((project) => project.id === gone.projectId);
  const next = main ?? after[0];
  return next ? refKeyOf(projectRef(next.id)) : null;
}
