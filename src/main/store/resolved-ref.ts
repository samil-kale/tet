import { projectRefName } from "../../shared/types/project";
import type { ProjectRef } from "../../shared/types/project";
import type { ProjectLookup } from "./project-store";
import { projectRefPath } from "./project-dirs";

/**
 * A project's repository or one of its worktrees as the runtime holds it (Repository, the session
 * manager): its address, its folder, and what a notice calls it — asked each time, since a
 * worktree's branch may be renamed meanwhile.
 */
export interface ResolvedRef {
  ref: ProjectRef;
  path: string;
  name(): string;
}

/** What a verb answers for a project id the store does not hold. */
export const PROJECT_NOT_FOUND = "Project not found";

/** What a verb answers for a repository or worktree that is not open: its name, or that its project
 *  is unknown. */
export function notOpenMessage(projects: ProjectLookup, ref: ProjectRef): string {
  const project = projects.get(ref.projectId);
  return project ? `${projectRefName(project, ref)} is not open` : PROJECT_NOT_FOUND;
}

/** The repository or worktree `ref` names, of a project the store holds. */
export function resolveProjectRef(dataRoot: string, projects: ProjectLookup, ref: ProjectRef): ResolvedRef {
  const project = projects.get(ref.projectId);
  if (!project) {
    throw new Error(PROJECT_NOT_FOUND);
  }
  // Kept for the notices of one closing after its project left the store.
  let name = projectRefName(project, ref);
  return {
    ref,
    path: projectRefPath(dataRoot, project, ref),
    name: () => {
      const current = projects.get(ref.projectId);
      name = current ? projectRefName(current, ref) : name;
      return name;
    },
  };
}
