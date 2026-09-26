import { WORKTREES_NEED_GIT } from "../../shared/types";
import type { CheckoutRef, GitActionResult } from "../../shared/types";
import { canDiscardCheckoutEdits } from "../diff/editor-views";
import type { GitRun } from "./run-action";
import type { ContextMenuEntry } from "../ui/ContextMenu";
import { askName, confirm, questionUp } from "../ui/Dialog";

/**
 * The worktree questions, asked alike from a sidebar row and from the branch tree's WORKTREES:
 * each view hands in how it runs a command (`GitRun`: its progress bar, and the failure either
 * notified or handed back to the field it was typed in).
 *
 * A worktree and its branch are one (projects.ts): made together, named by the branch, deleted
 * together.
 */
/** Why a worktree git lists offers nothing but its path: TET never opens one it did not make. */
export const NOT_MADE_BY_TET = "not created by TET";

/** A worktree entry in a menu, disabled saying `why` where there is a reason: git too old to create
 *  one (Requirements.worktrees), or one TET did not make. */
export function worktreeEntry(label: string, why: string | undefined, run: (() => void) | undefined): ContextMenuEntry {
  return why === undefined ? { label: `${label}...`, run } : { label: `${label} (${why})` };
}

/** Why "New worktree" is disabled, if it is. */
export function newWorktreeRefusal(supported: boolean): string | undefined {
  return supported ? undefined : WORKTREES_NEED_GIT;
}

/** Names the new branch, which names the worktree. It starts at the default branch, `base`. */
export async function askNewWorktree(projectId: string, run: GitRun, base: string): Promise<void> {
  await askName({
    title: "New worktree",
    detail: `A new worktree starting at ${base}, in its own folder under ~/.tet/projects.`,
    confirmLabel: "Create worktree",
    // The name is the branch's, so git refuses the same names here; shown at the field.
    submit: (name) =>
      run.ask(`Creating worktree ${name}...`, async () => {
        const added = await window.tet.projects.addWorktree(projectId, name);
        return added.project ? { ok: true } : { ok: false, error: added.error };
      })
  });
}

/** Renames the worktree's branch, which names it; the folder stays, and so do its terminals. Run in
 *  the main worktree, whose state lists the worktrees. */
export async function askRenameWorktree(projectId: string, branch: string, run: GitRun): Promise<void> {
  await askName({
    title: "Rename worktree",
    detail: "Renames its branch. Its terminals keep running.",
    current: branch,
    confirmLabel: "Rename",
    submit: (name) => run.ask(`Renaming ${branch}...`, () => window.tet.repository.renameBranch({ projectId }, branch, name))
  });
}

/**
 * GitHub Desktop's two questions: whether to delete, then — once the main process found changes,
 * before closing anything — whether to delete them too. The branch goes along; its upstream is a
 * checkbox, as on a branch's own delete. Its unsaved editor edits get a say, as on a close.
 */
export async function askDeleteWorktree(
  worktree: CheckoutRef,
  branch: string,
  upstream: string | undefined,
  run: GitRun
): Promise<void> {
  const answer = await confirm({
    title: "Delete worktree",
    message: `Are you sure you want to delete ${branch}?`,
    detail: "The worktree and its folder are deleted, and its terminals closed. Commits that exist only in this worktree are lost.",
    confirmLabel: "Delete worktree",
    checkboxLabel: upstream ? `Also delete ${upstream} on the remote` : undefined
  });
  if (!answer.confirmed || !(await canDiscardCheckoutEdits(worktree))) {
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
    // Not asked while another question is up (`askLogin`): the refusal is notified instead.
    if (questionUp()) {
      return { ok: false, error: `${branch} has uncommitted changes` };
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
