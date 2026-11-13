import type { AgentDefinition } from "../agents/agent";
import { errorMessage } from "../../shared/errors";
import type { ActionResult } from "../../shared/types/action";
import type { ProjectRef } from "../../shared/types/project";
import type { TabDescriptor } from "../../shared/types/terminals";
import { archivedIds, pruneArchived, setArchived, setArchivedOrder } from "../store/archive";
import { forgetSessionIssues } from "../store/issue-sessions";
import { logError } from "../util/error-log";
import type { TabPlace } from "./tab-place";
import { awaitsClaim, settleWithoutProcess, type TabState } from "./tab-state";
import { SESSION_REMOVE_DELAY_MS } from "./terminal-session";

/** What the archived tabs run on, handed in by the session manager. */
export interface ArchiveTarget {
  agentOf(tab: TabState): AgentDefinition;
  /** Where the tab's session lives (TabSessionManager.placeOf). */
  placeOf(tab: TabState): TabPlace;
  descriptorOf(tab: TabState): TabDescriptor;
  /** Session ids whose removal is in flight — reconcile must not re-claim them. The session
   *  manager's own, shared. */
  deletingSessionIds: Set<string>;
  /** The tab leaves the strip, its process asked to stop: what that stop resolves on, if it has
   *  one. */
  takeOffStrip(tab: TabState): Promise<void> | undefined;
  /** The tab goes back at the end of the strip. */
  reopened(tab: TabState): void;
  /** The archived tabs, whole, on every change (SessionManagerCallbacks.onArchived). */
  onChanged(tabs: TabDescriptor[]): void;
  removeHandoverCopy(dir: string): void;
}

/**
 * The tabs of a repository or worktree kept archived: their sessions the agent's own, archive.json
 * (store/archive.ts) naming which, shown in the ARCHIVE lane with no process until reopened or
 * deleted.
 */
export class ArchivedTabs {
  private tabs: TabState[] = [];
  /** An archived tab's process still stopping: its session is reopened or deleted only after. */
  private readonly stopping = new Map<string, Promise<void>>();

  constructor(
    private readonly dataRoot: string,
    private readonly ref: ProjectRef,
    private readonly target: ArchiveTarget,
  ) {}

  /** Every archived tab, in no order. */
  all(): readonly TabState[] {
    return this.tabs;
  }

  /** The session ids archive.json keeps archived here. */
  storedIds(): Set<string> {
    return new Set(archivedIds(this.dataRoot, this.ref));
  }

  /** Listed sessions archive.json keeps archived (TabSessionManager.bringUp). */
  add(tabs: TabState[]): void {
    if (tabs.length === 0) {
      return;
    }
    this.tabs.push(...tabs);
    this.post();
  }

  /** The archived tabs in the archive's own order: newest archived, or dragged, first. */
  snapshot(): TabDescriptor[] {
    const order = archivedIds(this.dataRoot, this.ref);
    const position = (sessionId: string | undefined): number => (sessionId === undefined ? -1 : order.indexOf(sessionId));
    return this.tabs.map((tab) => this.target.descriptorOf(tab)).sort((a, b) => position(a.sessionId) - position(b.sessionId));
  }

  post(): void {
    this.target.onChanged(this.snapshot());
  }

  /** Drops archive.json ids not among `present` (TabSessionManager.pruneArchive). */
  prune(present: Set<string>): void {
    pruneArchived(this.dataRoot, this.ref, present);
  }

  /**
   * Takes a tab off the strip and stops its process, keeping its session (`sessionId`, its own).
   * Written down before anything changes, so a refused write leaves the tab as it is. Answers what
   * refused it.
   */
  keep(tab: TabState, sessionId: string): ActionResult {
    const { displayName } = this.target.agentOf(tab);
    // Moved on to a session its hooks named (`/clear`) that no listing has shown yet.
    if (awaitsClaim(tab)) {
      return { ok: false, error: `The ${displayName} session is not listed yet: close the tab again in a moment` };
    }
    try {
      setArchived(this.dataRoot, this.ref, sessionId, true);
    } catch (error) {
      return { ok: false, error: `Could not keep the ${displayName} session: ${errorMessage(error)}` };
    }
    const stopped = this.target.takeOffStrip(tab);
    Object.assign(tab, { finishedAt: undefined, openedInTerminal: undefined });
    settleWithoutProcess(tab);
    this.tabs.push(tab);
    this.post();
    if (stopped) {
      const { tabId } = tab;
      this.stopping.set(
        tabId,
        stopped.then(() => {
          this.stopping.delete(tabId);
        }),
      );
    }
    return { ok: true };
  }

  /** Brings an archived tab back at the end of the strip; its session resumes at its first resize,
   *  as a restored tab's does. Checked first, as pruneArchive could not from here: a session
   *  deleted outside TET is dropped instead, answered rather than left to fail at that resize. */
  async reopen(tabId: string): Promise<ActionResult> {
    const tab = this.tabOf(tabId);
    if (!tab?.sessionId) {
      return { ok: true };
    }
    await this.stopping.get(tabId);
    if (!this.tabs.includes(tab)) {
      return { ok: true };
    }
    const agent = this.target.agentOf(tab);
    const sessionId = tab.sessionId;
    const gone = (await this.target.placeOf(tab).sessionActions()?.files(sessionId))?.length === 0;
    try {
      setArchived(this.dataRoot, this.ref, sessionId, false);
    } catch (error) {
      if (!gone) {
        return { ok: false, error: `Could not reopen the ${agent.displayName} session: ${errorMessage(error)}` };
      }
      logError(`could not forget the ${agent.displayName} session deleted outside TET`, error);
    }
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
    this.post();
    if (gone) {
      return { ok: false, error: `The ${agent.displayName} session was deleted outside TET` };
    }
    this.target.reopened(tab);
    return { ok: true };
  }

  /** A drag in the ARCHIVE lane: the tabs named by `tabIds`, in that order, become the stored
   *  order. Answers what refused it; the list stays as it was. */
  reorder(tabIds: string[]): ActionResult {
    const order = tabIds.map((tabId) => this.tabOf(tabId)?.sessionId).filter((id): id is string => id !== undefined);
    try {
      setArchivedOrder(this.dataRoot, this.ref, order);
    } catch (error) {
      return { ok: false, error: `Could not reorder the archived sessions: ${errorMessage(error)}` };
    }
    this.post();
    return { ok: true };
  }

  /** Renames an archived tab's session, once its process is gone, as `renameTab` does a tab's.
   *  Answers what the agent refused: the window's question shows it. */
  async rename(tabId: string, title: string): Promise<ActionResult> {
    const tab = this.tabOf(tabId);
    const sessionId = tab?.sessionId;
    if (!tab || !sessionId) {
      return { ok: true };
    }
    await this.stopping.get(tabId);
    try {
      await this.target.placeOf(tab).sessionActions()?.rename(sessionId, title);
    } catch (error) {
      return { ok: false, error: `Could not rename ${this.target.agentOf(tab).displayName} session: ${errorMessage(error)}` };
    }
    tab.title = title.trim();
    tab.provisionalTitle = false;
    this.post();
    return { ok: true };
  }

  /** Deletes an archived tab's session, once its process is gone. Answers what refused it: the
   *  tab stays archived. */
  async delete(tabId: string): Promise<ActionResult> {
    const tab = this.tabOf(tabId);
    const sessionId = tab?.sessionId;
    if (!tab || !sessionId) {
      return { ok: true };
    }
    const stopping = this.stopping.get(tabId);
    const deleting = this.target.deletingSessionIds;
    deleting.add(sessionId);
    try {
      if (stopping) {
        await stopping;
        // See SESSION_REMOVE_DELAY_MS.
        await new Promise((resolve) => setTimeout(resolve, SESSION_REMOVE_DELAY_MS));
      }
      await this.target.placeOf(tab).sessionActions()?.remove(sessionId);
      setArchived(this.dataRoot, this.ref, sessionId, false);
      forgetSessionIssues(this.dataRoot, this.ref, sessionId);
    } catch (error) {
      return { ok: false, error: `Could not delete the ${this.target.agentOf(tab).displayName} session: ${errorMessage(error)}` };
    } finally {
      deleting.delete(sessionId);
    }
    this.tabs = this.tabs.filter((candidate) => candidate !== tab);
    // As TabSessionManager.destroyTab: the copy goes with the tab.
    if (tab.handoverDir !== undefined) {
      this.target.removeHandoverCopy(tab.handoverDir);
    }
    this.post();
    return { ok: true };
  }

  /** Closed. */
  dispose(): void {
    this.tabs = [];
  }

  private tabOf(tabId: string): TabState | undefined {
    return this.tabs.find((candidate) => candidate.tabId === tabId);
  }
}
