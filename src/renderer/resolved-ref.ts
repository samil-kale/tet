import { refKeyOf, projectRefName, projectRefsOf, worktreeOf } from "../shared/types/project";
import type { Project, ProjectRef, ProjectWorktree } from "../shared/types/project";
import { stableRecord } from "./identity";

/**
 * A project's repository or one of the worktrees TET made, as the window holds it.
 * Views take this, keep their records by `refKey` and hand `ref` to main — never a ref built inline,
 * which would be a new prop on every render.
 */
export interface ResolvedRef {
  /** `refKeyOf(ref)`: what every record of the window is keyed by. */
  refKey: string;
  ref: ProjectRef;
  /** Absent for the repository. */
  worktree?: ProjectWorktree;
  /** Its folder. */
  path: string;
  /** What a row, a dialog or a notice calls it (projectRefName). */
  name: string;
}

function resolveEntry(project: Project, ref: ProjectRef): ResolvedRef {
  const worktree = worktreeOf(project, ref);
  return {
    refKey: refKeyOf(ref),
    ref,
    worktree,
    path: worktree?.path ?? project.path,
    name: projectRefName(project, ref)
  };
}

/** Unchanged where what it shows is: every `projects:changed` brings new objects, so all is
 *  compared by value — the ref by its `refKey`. */
function sameResolved(previous: ResolvedRef, entry: ResolvedRef): boolean {
  return (
    previous.refKey === entry.refKey &&
    previous.path === entry.path &&
    previous.name === entry.name &&
    previous.worktree?.branch === entry.worktree?.branch
  );
}

/** The repository and every worktree open, by refKey, in the projects lane's order, each kept where
 *  unchanged (`ref` holds what was last handed out). */
export function resolvedByRefKey(ref: { current: Record<string, ResolvedRef> }, projects: Project[]): Record<string, ResolvedRef> {
  const next: Record<string, ResolvedRef> = {};
  for (const project of projects) {
    for (const at of projectRefsOf(project)) {
      const entry = resolveEntry(project, at);
      next[entry.refKey] = entry;
    }
  }
  return stableRecord(ref, next, sameResolved);
}
