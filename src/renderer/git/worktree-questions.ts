import { WORKTREES_NEED_GIT } from "../../shared/types";
import type { GitActionResult, WorktreeRef } from "../../shared/types";
import type { GitRun } from "./run-action";
import type { ContextMenuEntry } from "../ui/ContextMenu";
import { confirm, filled, prompt, singleField } from "../ui/Dialog";

/**
 * The worktree questions, asked alike from a project row and from the branch tree's WORKTREES:
 * each view hands in how it runs a command (`GitRun`: its progress bar, and the failure either
 * notified or handed back to the field it was typed in) and, where the worktree is an open project,
 * whether its unsaved editor edits may go with its terminals.
 *
 * A worktree and its branch are one (projects.ts): made together under one name, renamed and
 * deleted together.
 */
/** "New worktree" or "Rename worktree" in a menu: disabled, saying why, where git is too old
 *  (Requirements.worktrees). */
export function worktreeEntry(label: string, supported: boolean, run: (() => void) | undefined): ContextMenuEntry {
  return supported ? { label: `${label}...`, run } : { label: `${label} (${WORKTREES_NEED_GIT})` };
}

/** Names the new branch, which names the worktree. It starts at the default branch, `base`. */
export async function askNewWorktree(projectId: string, run: GitRun, base: string): Promise<void> {
  await prompt({
    title: "New worktree",
    detail: `A new worktree starting at ${base}, in its own folder under ~/.tet/worktrees.`,
    value: "",
    confirmLabel: "Create worktree",
    ready: filled,
    render: singleField("Name"),
    // The name is the branch's, so git refuses the same names here; shown at the field.
    submit: (typed) => {
      const name = typed.trim();
      return run.ask(`Creating worktree ${name}...`, async () => {
        const added = await window.tet.projects.addWorktree(projectId, name);
        return added.project ? { ok: true } : { ok: false, error: added.error };
      });
    }
  });
}

/** Its terminals end first, which unsaved editor edits get a say in, as on a close. */
export async function askRenameWorktree(
  worktree: WorktreeRef,
  branch: string,
  run: GitRun,
  canClose: () => Promise<boolean>
): Promise<void> {
  await prompt({
    title: "Rename worktree",
    detail: "Renames the worktree and its folder. Its terminals are closed first, and agent sessions started there can no longer be resumed.",
    value: branch,
    confirmLabel: "Rename",
    ready: filled,
    render: singleField("Name"),
    // Unchanged, or its unsaved edits kept it: nothing to say, and the question is done.
    submit: async (name) =>
      name.trim() === branch || !(await canClose())
        ? undefined
        : run.ask(`Renaming ${branch}...`, () => window.tet.projects.renameWorktree(worktree, name.trim()))
  });
}

/**
 * GitHub Desktop's two questions: whether to delete, then — once the main process found changes,
 * before closing anything — whether to delete them too. The branch goes along; its upstream is a
 * checkbox, as on a branch's own delete.
 */
export async function askDeleteWorktree(
  worktree: WorktreeRef,
  branch: string,
  upstream: string | undefined,
  run: GitRun,
  canClose: () => Promise<boolean>
): Promise<void> {
  const answer = await confirm({
    title: "Delete worktree",
    message: `Are you sure you want to delete ${branch}?`,
    detail: "The worktree and its folder are deleted, and its terminals closed. Commits that exist only in this worktree are lost.",
    confirmLabel: "Delete worktree",
    checkboxLabel: upstream ? `Also delete ${upstream} on the remote` : undefined
  });
  if (!answer.confirmed || !(await canClose())) {
    return;
  }
  const options = { force: false, onRemote: answer.checked };
  /** No login is asked for the upstream: the worktree and its branch are gone by then, and with
   *  them what names the upstream to try again. git's words are notified. */
  const deleted = async (force: boolean): Promise<GitActionResult> => {
    const result = await window.tet.projects.deleteWorktree(worktree, { ...options, force });
    return result.needsConfirmation === "uncommitted" ? result : { ok: result.ok, error: result.error };
  };
  run.run(`Deleting ${branch}...`, async () => {
    const result = await deleted(false);
    if (result.needsConfirmation !== "uncommitted") {
      return result;
    }
    const forced = await confirm({
      title: "Delete worktree",
      message: `${branch} has uncommitted changes. Delete them too?`,
      detail: "Its changed and untracked files are lost.",
      confirmLabel: "Delete worktree"
    });
    return forced.confirmed ? deleted(true) : { ok: true };
  });
}
