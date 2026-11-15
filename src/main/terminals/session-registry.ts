import { errorMessage } from "../../shared/errors";
import { type ProjectRef, refKeyOf } from "../../shared/types/project";
import type { TabDescriptor } from "../../shared/types/terminals";
import type { SbxLocalStore } from "../sbx/sbx-local";
import type { ResolvedRef } from "../store/resolved-ref";
import type { SettingsStore } from "../store/settings";
import { HostSetups } from "./host-setup";
import { IssueLinks } from "./issue-links";
import type { TerminalEnv } from "./pty";
import { TabSessionManager, type SessionManagerCallbacks } from "./session-manager";

export interface SessionRegistryCallbacks extends SessionManagerCallbacks {
  /** What the project's issues show of their sessions changed (`issues.ts`'s issueSessions): a link,
   *  a linked tab, the archive, a repository or worktree opened or closed. */
  onIssueSessions: (projectId: string) => void;
}

/** A session manager per open repository and worktree, by `refKey`, and the project's links of
 *  issues and sessions they share. */
export class SessionManagerRegistry {
  private readonly managers = new Map<string, TabSessionManager>();
  private readonly issueLinks: IssueLinks;
  /** The callbacks the managers get: the window's, and what tells of the issues' sessions. */
  private readonly managerCallbacks: SessionManagerCallbacks;
  /** What each repository's or worktree's tabs linked to an issue last showed, by `refKey`: the
   *  issues' sessions change with it alone, not with every turn. */
  private readonly linkedShown = new Map<string, string>();

  /** The renderer's last report, sent only on change — for a repository or worktree opened after
   *  it. */
  private onScreen: { refKey: string | null; tabIds: readonly string[] } = { refKey: null, tabIds: [] };
  private readonly hostSetups: HostSetups;

  constructor(
    private readonly dataRoot: string,
    private readonly settings: SettingsStore,
    private readonly sbxLocal: SbxLocalStore,
    private readonly terminalEnv: TerminalEnv,
    private readonly callbacks: SessionRegistryCallbacks,
  ) {
    this.hostSetups = new HostSetups(dataRoot, settings, callbacks.onNotice);
    this.issueLinks = new IssueLinks(
      dataRoot,
      ({ ref, tabId }) => this.get(ref)?.hasTab(tabId) === true,
      (projectId) => {
        for (const manager of this.forProject(projectId)) {
          manager.repostTabs();
        }
        callbacks.onIssueSessions(projectId);
      },
    );
    this.managerCallbacks = {
      ...callbacks,
      onTabs: (ref, tabs) => {
        callbacks.onTabs(ref, tabs);
        this.linkedTabsShown(ref, tabs);
      },
      onArchived: (ref, tabs) => {
        callbacks.onArchived(ref, tabs);
        callbacks.onIssueSessions(ref.projectId);
      },
    };
  }

  private linkedTabsShown(ref: ProjectRef, tabs: TabDescriptor[]): void {
    const refKey = refKeyOf(ref);
    const shown = JSON.stringify(
      tabs.flatMap(({ tabId, issue, agentId, title }) => (issue === undefined ? [] : [[tabId, issue, agentId, title]])),
    );
    if (shown !== (this.linkedShown.get(refKey) ?? "[]")) {
      this.linkedShown.set(refKey, shown);
      this.callbacks.onIssueSessions(ref.projectId);
    }
  }

  open(resolved: ResolvedRef): TabSessionManager {
    const refKey = refKeyOf(resolved.ref);
    const existing = this.managers.get(refKey);
    if (existing) {
      return existing;
    }
    const manager = new TabSessionManager(
      resolved,
      this.dataRoot,
      this.settings,
      this.sbxLocal,
      this.hostSetups,
      this.issueLinks,
      this.terminalEnv,
      this.managerCallbacks,
    );
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
    if (this.linkedShown.delete(refKey)) {
      this.callbacks.onIssueSessions(ref.projectId);
    }
    await manager?.dispose();
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.dispose()));
    this.managers.clear();
  }
}
