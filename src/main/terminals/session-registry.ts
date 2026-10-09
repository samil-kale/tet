import { errorMessage } from "../../shared/errors";
import { type ProjectRef, refKeyOf } from "../../shared/types/project";
import type { SbxLocalStore } from "../sbx/sbx-local";
import type { ResolvedRef } from "../store/resolved-ref";
import type { SettingsStore } from "../store/settings";
import { HostSetups } from "./host-setup";
import { TabSessionManager, type SessionManagerCallbacks } from "./session-manager";

/** A session manager per open repository and worktree, by `refKey`. */
export class SessionManagerRegistry {
  private readonly managers = new Map<string, TabSessionManager>();

  /** The renderer's last report, sent only on change — for a repository or worktree opened after
   *  it. */
  private onScreen: { refKey: string | null; tabIds: readonly string[] } = { refKey: null, tabIds: [] };
  private readonly hostSetups: HostSetups;

  constructor(
    private readonly dataRoot: string,
    private readonly settings: SettingsStore,
    private readonly sbxLocal: SbxLocalStore,
    private readonly callbacks: SessionManagerCallbacks,
  ) {
    this.hostSetups = new HostSetups(dataRoot, settings, callbacks.onNotice);
  }

  open(resolved: ResolvedRef): TabSessionManager {
    const refKey = refKeyOf(resolved.ref);
    const existing = this.managers.get(refKey);
    if (existing) {
      return existing;
    }
    const manager = new TabSessionManager(resolved, this.dataRoot, this.settings, this.sbxLocal, this.hostSetups, this.callbacks);
    manager.setOnScreen(refKey === this.onScreen.refKey ? this.onScreen.tabIds : []);
    this.managers.set(refKey, manager);
    manager.bootstrap().catch((error: unknown) => {
      this.callbacks.onNotice("error", `${resolved.name()} could not be opened: ${errorMessage(error)}`);
    });
    return manager;
  }

  get(ref: ProjectRef): TabSessionManager | undefined {
    return this.managers.get(refKeyOf(ref));
  }

  /** Those of the project's repository and worktrees that are open. */
  forProject(projectId: string): TabSessionManager[] {
    return [...this.managers.values()].filter((manager) => manager.at.ref.projectId === projectId);
  }

  /** The tabs on screen belong to one repository or worktree at most. */
  setOnScreen(ref: ProjectRef | null, tabIds: readonly string[]): void {
    const refKey = ref && refKeyOf(ref);
    this.onScreen = { refKey, tabIds };
    for (const [id, manager] of this.managers) {
      manager.setOnScreen(id === refKey ? tabIds : []);
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
    const refKey = refKeyOf(ref);
    const manager = this.managers.get(refKey);
    // Dropped before the wait, so a repository or worktree closed and reopened at once never has
    // two.
    this.managers.delete(refKey);
    await manager?.dispose();
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.dispose()));
    this.managers.clear();
  }
}
