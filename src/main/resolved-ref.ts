import { projectRefName } from "../shared/types";
import type { ProjectRef } from "../shared/types";
import { projectRefPath } from "./project-dirs";
import type { ProjectLookup } from "./projects";

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

/** The repository or worktree `ref` names, of a project the store holds. */
export function resolveProjectRef(dataRoot: string, projects: ProjectLookup, ref: ProjectRef): ResolvedRef {
  const project = projects.get(ref.projectId);
  if (!project) {
    throw new Error(`Project not found: ${ref.projectId}`);
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
    }
  };
}
