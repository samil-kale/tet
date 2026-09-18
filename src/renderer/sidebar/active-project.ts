import type { Project } from "../../shared/types";

/**
 * The project in front after `projects:changed`, from the one in front before (`current`) and the
 * lists before and after. A project added on its own comes to the front. One added in place of one
 * removed — a worktree renamed, or reopened after a failed delete — takes over only where that one
 * was in front. A removed project in front gives way to its main worktree's project when it was a
 * worktree, else to the first.
 */
export function activeAfterChange(
  current: string | null,
  before: readonly Project[],
  after: readonly Project[],
  added: string | undefined,
  removed: string | undefined
): string | null {
  if (removed === undefined) {
    return added ?? current;
  }
  if (current !== removed) {
    return current;
  }
  const gone = before.find((project) => project.id === removed);
  const main = gone?.mainPath === undefined ? undefined : after.find((project) => project.path === gone.mainPath);
  return added ?? main?.id ?? after[0]?.id ?? null;
}
