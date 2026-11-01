import type { ProjectRef } from "../shared/types/project";

const listeners = new Set<(ref: ProjectRef) => void>();

/**
 * Calls `listener` when a repository or worktree closes for good, so what is held per one lets go of
 * it where it is held; anything new held by `refKey` listens here. Answers the unsubscribe.
 */
export function onRefClosed(listener: (ref: ProjectRef) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The repository or worktree closed: `App` says so, as main announced it (`projects:changed`). */
export function refClosed(ref: ProjectRef): void {
  for (const listener of [...listeners]) {
    listener(ref);
  }
}
