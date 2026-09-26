import { checkoutName } from "../shared/types";
import type { CheckoutRef } from "../shared/types";
import { checkoutPath } from "./project-dirs";
import type { ProjectLookup } from "./projects";

/**
 * A checkout as the runtime holds it (Repository, the session manager): its address, its folder, and
 * what a notice calls it — asked each time, since a worktree's branch may be renamed meanwhile.
 */
export interface Checkout {
  ref: CheckoutRef;
  path: string;
  name(): string;
}

/** The checkout `ref` names, of a project the store holds. */
export function checkoutOf(dataRoot: string, projects: ProjectLookup, ref: CheckoutRef): Checkout {
  const project = projects.get(ref.projectId);
  if (!project) {
    throw new Error(`Project not found: ${ref.projectId}`);
  }
  // Kept for the notices of a checkout closing after its project left the store.
  let name = checkoutName(project, ref);
  return {
    ref,
    path: checkoutPath(dataRoot, project, ref),
    name: () => {
      const current = projects.get(ref.projectId);
      name = current ? checkoutName(current, ref) : name;
      return name;
    }
  };
}
