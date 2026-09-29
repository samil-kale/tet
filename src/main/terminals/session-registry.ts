import { errorMessage } from "../../shared/errors";
import { type ProjectRef, projectRefKey } from "../../shared/types/project";
import type { SbxLocalStore } from "../sbx/sbx-local";
import type { ResolvedRef } from "../store/resolved-ref";
import type { SettingsStore } from "../store/settings";
import { HostSetups } from "./host-setup";
import { TabSessionManager, type SessionManagerCallbacks } from "./session-manager";

/** A session manager per open repository and worktree, by `projectRefKey`. */
export class SessionManagerRegistry {
  private readonly managers = new Map<string, TabSessionManager>();

  /** The renderer's last report, sent only on change — for a repository or worktree opened after
   *  it. */
  private inFront: { key: string | null; tabIds: readonly string[] } = { key: null, tabIds: [] };
  private readonly hostSetups: HostSetups;

  constructor(
    private readonly storageRoot: string,
    private readonly settings: SettingsStore,
    private readonly sbxLocal: SbxLocalStore,
    private readonly callbacks: SessionManagerCallbacks
  ) {
    this.hostSetups = new HostSetups(storageRoot, settings, callbacks.onNotice);
  }

  open(resolved: ResolvedRef): TabSessionManager {
    const key = projectRefKey(resolved.ref);
    const existing = this.managers.get(key);
    if (existing) {
      return existing;
    }
    const manager = new TabSessionManager(resolved, this.storageRoot, this.settings, this.sbxLocal, this.hostSetups, this.callbacks);
    manager.setInFront(key === this.inFront.key ? this.inFront.tabIds : []);
    this.managers.set(key, manager);
    manager.bootstrap().catch((error: unknown) => {
      this.callbacks.onNotice("error", `${resolved.name()} could not be opened: ${errorMessage(error)}`);
    });
    return manager;
  }

  get(ref: ProjectRef): TabSessionManager | undefined {
    return this.managers.get(projectRefKey(ref));
  }

  /** Those of the project's repository and worktrees that are open. */
  forProject(projectId: string): TabSessionManager[] {
    return [...this.managers.values()].filter((manager) => manager.at.ref.projectId === projectId);
  }

  /** The tabs in front belong to one repository or worktree at most. */
  setInFront(ref: ProjectRef | null, tabIds: readonly string[]): void {
    const key = ref && projectRefKey(ref);
    this.inFront = { key, tabIds };
    for (const [id, manager] of this.managers) {
      manager.setInFront(id === key ? tabIds : []);
    }
  }

  /** See HostSetups.themeChanged. */
  themeChanged(): void {
    this.hostSetups.themeChanged();
  }

  /** See HostSetups.idleReminderChanged. */
  idleReminderChanged(): void {
    this.hostSetups.idleReminderChanged();
  }

  async close(ref: ProjectRef): Promise<void> {
    const manager = this.managers.get(projectRefKey(ref));
    // Dropped before the wait, so a repository or worktree closed and reopened at once never has
    // two.
    this.managers.delete(projectRefKey(ref));
    await manager?.dispose();
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.dispose()));
    this.managers.clear();
  }
}
