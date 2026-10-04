/**
 * How many things are still starting in a repository or worktree, in all and per tab: the tab
 * strip's bar stays up while any is. With a tab id that tab's pane shows the bar; without
 * (bootstrap) it falls to pane "a". Every acquire needs one release with the same tab id.
 */
export class StartIndicators {
  private total = 0;
  /**
   * Those per tab (`TabDescriptor.starting`). A count: a tab's setup and first frame overlap,
   * and a release for a closed tab must balance its acquire (`closeTabs` can put a tab back).
   */
  private readonly perTab = new Map<string, number>();
  private disposed = false;

  constructor(
    /** The first began or the last ended. */
    private readonly onProgress: (show: boolean) => void,
    /** A tab's first began or its last ended. */
    private readonly onTabChange: () => void
  ) {}

  acquire(tabId?: string): void {
    this.total += 1;
    if (this.total === 1) {
      this.onProgress(true);
    }
    if (tabId !== undefined) {
      const count = this.perTab.get(tabId) ?? 0;
      this.perTab.set(tabId, count + 1);
      if (count === 0) {
        this.onTabChange();
      }
    }
  }

  release(tabId?: string): void {
    // `dispose` already zeroed the counts.
    if (this.disposed) {
      return;
    }
    this.total -= 1;
    if (this.total === 0) {
      this.onProgress(false);
    }
    if (tabId !== undefined) {
      const count = this.perTab.get(tabId) ?? 0;
      if (count <= 1) {
        this.perTab.delete(tabId);
        this.onTabChange();
      } else {
        this.perTab.set(tabId, count - 1);
      }
    }
  }

  /** Whether anything is still starting. */
  any(): boolean {
    return this.total > 0;
  }

  /** Whether something of this tab is still starting. */
  has(tabId: string): boolean {
    return this.perTab.has(tabId);
  }

  /** Zeroes the counts; a release after it balances nothing. */
  dispose(): void {
    this.disposed = true;
    this.perTab.clear();
    this.total = 0;
  }
}
