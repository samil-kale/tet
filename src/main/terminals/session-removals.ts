import { SESSION_REMOVE_DELAY_MS } from "./terminal-session";

/**
 * The sessions of a repository's or worktree's tabs being deleted, of a tab on the strip or archived:
 * the session manager's listing (bringUp, reconcile) must not claim one again meanwhile. Owned by the
 * session manager, which hands it to its archived tabs; each deletes its own tabs' sessions through
 * `during`.
 */
export class SessionRemovals {
  private readonly ids = new Set<string>();

  /** Every session whose deletion is underway. */
  all(): string[] {
    return [...this.ids];
  }

  /** Whether the session's deletion is underway. */
  has(sessionId: string): boolean {
    return this.ids.has(sessionId);
  }

  /**
   * Runs `remove` with the session counted as being deleted until it settles. `stopped` is the end of
   * its tab's process, where it had one: waited for, and SESSION_REMOVE_DELAY_MS after it, before
   * `remove` runs.
   */
  async during<T>(sessionId: string, stopped: Promise<void> | undefined, remove: () => Promise<T>): Promise<T> {
    this.ids.add(sessionId);
    try {
      if (stopped) {
        await stopped;
        await new Promise((resolve) => setTimeout(resolve, SESSION_REMOVE_DELAY_MS));
      }
      return await remove();
    } finally {
      this.ids.delete(sessionId);
    }
  }
}
