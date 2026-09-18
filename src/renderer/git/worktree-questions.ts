import type { GitActionResult, WorktreeRef } from "../../shared/types";
import { confirm, prompt } from "../ui/Dialog";

/**
 * The worktree questions, asked alike from a project row and from the branch tree's WORKTREES:
 * each view hands in how it runs a command (its progress bar, a failure as a notice) and, where the
 * worktree is an open project, whether its unsaved editor edits may go with its terminals.
 *
 * A worktree and its branch are one (projects.ts): made together under one name, renamed and
 * deleted together.
 */
type Run = (label: string, action: () => Promise<GitActionResult>) => void;

/** Always, for a worktree that is no project and so has no editor tabs. */
const NOTHING_UNSAVED = (): Promise<boolean> => Promise.resolve(true);

/** Names the new branch, which names the worktree. It starts at the default branch, `base`. */
export async function askNewWorktree(projectId: string, run: Run, base: string): Promise<void> {
  const answer = await prompt({
    title: "New worktree",
    label: "Name",
    detail: `A new worktree starting at ${base}, in its own folder under ~/.tet/worktrees and opened as a project.`,
    value: "",
    confirmLabel: "Create worktree"
  });
  if (!answer) {
    return;
  }
  run(`Creating worktree ${answer.value}...`, async () => {
    const added = await window.tet.projects.addWorktree(projectId, answer.value);
    return added.project ? { ok: true } : { ok: false, error: added.error };
  });
}

/**
 * The worktree's branch into the branch it was made from, where that is checked out: `base` is
 * recorded at creation (git.ts's worktreeAdd), `run` runs in the project holding it.
 */
export function mergeIntoBase(branch: string, base: string, baseProjectId: string, run: Run): void {
  run(`Merging ${branch} into ${base}...`, () => window.tet.repository.merge(baseProjectId, branch));
}

/** Its terminals end first, which unsaved editor edits get a say in, as on a close. */
export async function askRenameWorktree(
  worktree: WorktreeRef,
  branch: string,
  run: Run,
  canClose: () => Promise<boolean> = NOTHING_UNSAVED
): Promise<void> {
  const answer = await prompt({
    title: "Rename worktree",
    label: "Name",
    detail: "Renames the worktree and its folder. Its terminals are closed first, and agent sessions started there can no longer be resumed.",
    value: branch,
    confirmLabel: "Rename"
  });
  if (answer && answer.value !== branch && (await canClose())) {
    run(`Renaming ${branch}...`, () => window.tet.projects.renameWorktree(worktree, answer.value));
  }
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
  run: Run,
  canClose: () => Promise<boolean> = NOTHING_UNSAVED
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
  run(`Deleting ${branch}...`, async () => {
    const result = await window.tet.projects.deleteWorktree(worktree, options);
    if (!result.uncommitted) {
      return result;
    }
    const forced = await confirm({
      title: "Delete worktree",
      message: `${branch} has uncommitted changes. Delete them too?`,
      detail: "Its changed and untracked files are lost.",
      confirmLabel: "Delete worktree"
    });
    return forced.confirmed ? window.tet.projects.deleteWorktree(worktree, { ...options, force: true }) : { ok: true };
  });
}
