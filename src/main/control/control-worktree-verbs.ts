import type { ControlRequest, ControlVerbName } from "../../shared/control";
import { projectRef, sameProjectRef, worktreeOf } from "../../shared/types/project";
import { isWorking } from "../../shared/types/terminals";
import type { Project, ProjectRef } from "../../shared/types/project";
import {
  callerRef,
  ControlError,
  refuseUnsaved,
  repositoryOf,
  tetWorktree,
  text,
  type ControlDeps,
  type Handler,
  type RefFrom
} from "./control-verb";

/**
 * The worktree verbs: add, delete, and the merge an agent runs. `refFrom` is the server's lookup of
 * the repository or worktree a verb acts on (resolveCallerRef).
 */
export function worktreeVerbs(
  deps: ControlDeps,
  refFrom: RefFrom
): Record<Extract<ControlVerbName, `worktree-${string}`>, Handler> {
  const { sessions } = deps;
  const project = (args: Record<string, unknown>, caller: ControlRequest["caller"]): Project => refFrom(args, caller).project;
  const repository = (ref: ProjectRef) => repositoryOf(deps, ref);

  return {
    "worktree-add": async (args, caller) => {
      const branch = text(args, "branch", "branch");
      const added = await deps.addWorktree(project(args, caller).id, branch);
      const worktree = added.project && worktreeOf(added.project, projectRef(added.project.id, added.worktree));
      if (!added.project || !worktree) {
        throw new ControlError("bad_args", added.error ?? "could not create the worktree");
      }
      return { result: { projectId: added.project.id, worktree: worktree.key, branch: worktree.branch ?? branch, path: worktree.path } };
    },

    // Named by its branch within the project, as worktree-add names it, so a worktree of another
    // repository cannot be reached. Not the caller's own: it would end the caller's tab before the
    // folder can go.
    "worktree-delete": async (args, caller) => {
      const found = project(args, caller);
      const branch = text(args, "branch", "branch");
      const { ref } = tetWorktree(found, branch);
      if (sameProjectRef(ref, callerRef(caller))) {
        throw new ControlError("bad_args", "a worktree cannot delete itself: run this from another tab of its project");
      }
      refuseUnsaved(deps, [ref], "nothing was deleted");
      const deleted = await deps.deleteWorktree(ref, args.force === true);
      if (deleted.needsConfirmation === "uncommitted") {
        throw new ControlError("bad_args", `${branch} has uncommitted changes: pass --force to delete them too`);
      }
      if (!deleted.ok) {
        throw new ControlError("bad_args", deleted.error ?? "could not delete the worktree");
      }
      return { result: { deleted: branch } };
    },

    // From the repository alone: the worktree goes at the end, which would end a caller inside it.
    // Every step before the fast-forward leaves nothing to undo, so each refusal says what to do
    // and that running it again picks up where it stopped.
    "worktree-agent-merge": async (args, caller) => {
      const found = project(args, caller);
      const name = text(args, "branch", "branch");
      if (caller.worktree !== undefined) {
        throw new ControlError(
          "bad_args",
          `worktree-agent-merge runs only from the project's repository: it deletes the worktree when done, which would close this tab. Run "tet-ctl worktree-agent-merge ${name}" from a tab of the repository, or ask the user to.`
        );
      }
      const { worktree, ref } = tetWorktree(found, name);
      const branch = worktree.branch;
      if (branch === undefined) {
        throw new ControlError("bad_args", `the worktree ${name} has no branch checked out, so there is nothing to merge: check one out there or delete the worktree`);
      }
      const main = repository(projectRef(found.id));
      const listed = main.getState().worktrees;
      const base = listed.find((entry) => entry.key === worktree.key)?.base;
      if (base === undefined) {
        throw new ControlError("bad_args", `${branch} has no recorded base, so TET cannot tell where it goes: merge it with git yourself`);
      }
      const checkedOut = listed.find((entry) => entry.main)?.branch;
      if (checkedOut !== base) {
        throw new ControlError(
          "bad_args",
          `the repository has ${checkedOut ?? "a detached HEAD"} checked out, not ${branch}'s base ${base}: run "git switch ${base}" there, or ask the user, then run this again`
        );
      }
      const own = repository(ref);
      const state = own.getState();
      if (state.operation !== undefined) {
        throw new ControlError(
          "bad_args",
          `a ${state.operation} is in progress in ${worktree.path}: resolve and commit it (or abort it with git), then run this again`
        );
      }
      if (state.changes.length > 0) {
        throw new ControlError(
          "bad_args",
          `${branch} has uncommitted changes, nothing was merged: have them committed or stashed there (by its agent or the user), then run this again`
        );
      }
      const working = sessions.get(ref)?.inspect().find(isWorking);
      if (working) {
        throw new ControlError("bad_args", `an agent in ${branch} is mid-turn (tab ${working.tabId}), nothing was merged: wait until it is done, then run this again`);
      }
      refuseUnsaved(deps, [ref], "nothing was merged");

      const merged = await own.merge(base);
      if (!merged.ok) {
        const conflicts = own.getState();
        if (conflicts.operation !== "merge") {
          throw new ControlError("bad_args", `${merged.error ?? "the merge failed"} — ${branch} is unchanged`);
        }
        // Where the caller sees the worktree: mounted into its sandbox if it would not.
        const [handed] = caller.tabId === undefined ? [] : ((await sessions.get(projectRef(found.id))?.seenPaths(caller.tabId, [worktree.path])) ?? []);
        const at = handed ?? worktree.path;
        return {
          result: {
            status: "conflicts",
            path: at,
            files: conflicts.changes.filter((change) => change.status === "conflicted").map((change) => change.path),
            next: `resolve the conflicts in ${at}, git add and git commit them there (or git merge --abort), then run "tet-ctl worktree-agent-merge ${branch}" again`
          }
        };
      }
      const markers = await own.conflictMarkers(base);
      if (markers.length > 0) {
        throw new ControlError(
          "bad_args",
          `conflict markers are left in ${markers.join(", ")} of ${branch}, ${base} is unchanged: remove them, commit, then run this again`
        );
      }
      const forwarded = await main.merge(branch, base);
      if (!forwarded.ok) {
        throw new ControlError(
          "bad_args",
          `${forwarded.error ?? "the fast-forward failed"} — the merge is committed in ${branch}, ${base} is unchanged: commit or stash what is in the way in the repository if anything is, then run this again`
        );
      }
      const deleted = await deps.deleteWorktree(ref, false);
      if (!deleted.ok) {
        const why =
          deleted.needsConfirmation === "uncommitted"
            ? `it has uncommitted changes since: look at them, then run "tet-ctl worktree-delete ${branch}" (--force if they can go)`
            : `${deleted.error ?? "unknown error"}: run "tet-ctl worktree-delete ${branch}"`;
        throw new ControlError("bad_args", `${branch} is merged into ${base}, but its worktree could not be deleted — ${why}`);
      }
      return { result: { status: "merged", base, branch } };
    }
  };
}
