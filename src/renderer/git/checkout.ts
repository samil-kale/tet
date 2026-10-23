import type { CheckoutTarget, RepositoryState, WorktreeInfo } from "../../shared/types/git";
import { projectRef, refKeyOf, worktreeName } from "../../shared/types/project";
import type { ResolvedRef } from "../resolved-ref";
import { notify } from "../ui/Notices";
import { MADE_ELSEWHERE } from "./worktree-questions";
import type { BranchActions } from "./run-action";

export const WORKTREE_KEEPS_BRANCH = "A worktree keeps its own branch: check out in the repository, or add a worktree";

/** Whether the state is a linked worktree's: it keeps its branch, nothing switches it
 *  (projects.ts couples the two). */
export function inLinkedWorktree(state: RepositoryState): boolean {
  return state.worktrees.some((worktree) => !worktree.isRepository && worktree.current);
}

/** Makes the repository or a worktree TET made active; a worktree made elsewhere is never
 *  opened, so it is only told. `onActivateRef` makes a repository or worktree of the project
 *  active, by its `refKey`. */
export function openWorktree(projectId: string, worktree: WorktreeInfo, onActivateRef: (refKey: string) => void): void {
  // The repository's has no key, which addresses the repository.
  if (worktree.isRepository || worktree.key !== undefined) {
    onActivateRef(refKeyOf(projectRef(projectId, worktree.key)));
  } else {
    notify("info", `${worktreeName(worktree)} is checked out in ${worktree.path}, a worktree ${MADE_ELSEWHERE}`);
  }
}

/** A branch checked out in another worktree is shown there, as in GitHub Desktop; git would
 *  refuse the switch. */
export function checkout(
  resolved: ResolvedRef,
  state: RepositoryState,
  branch: BranchActions,
  target: CheckoutTarget,
  onActivateRef: (refKey: string) => void,
): void {
  // Where the local branch a checkout would switch to is checked out in another worktree.
  const worktree =
    target.remote === undefined || state.localBranches.includes(target.name)
      ? state.worktrees.find((candidate) => !candidate.current && candidate.branch === target.name)
      : undefined;
  if (worktree !== undefined) {
    openWorktree(resolved.ref.projectId, worktree, onActivateRef);
    return;
  }
  if (inLinkedWorktree(state)) {
    notify("info", WORKTREE_KEEPS_BRANCH);
    return;
  }
  branch.run(`Switching to ${target.name}...`, () => window.tet.repository.checkout(resolved.ref, target));
}
