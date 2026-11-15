import { sameProjectRef, type ProjectRef } from "../../shared/types/project";
import type { IssueLinkChange, TabRef } from "../../shared/types/terminals";
import { issueSessionLinks, linkIssueSession, unlinkIssueSession } from "../store/issue-sessions";
import { logFailure } from "../util/json-file";
import type { TabState } from "./tab-state";

function isTab(at: TabRef, ref: ProjectRef, tabId: string): boolean {
  return at.tabId === tabId && sameProjectRef(at.ref, ref);
}

/**
 * Every link between the project's issues and its sessions, in the repository and its worktrees
 * alike: an issue has one session, a session one issue. A session's link is kept by the store
 * (issue-sessions.ts); a tab that has no session yet, or waits to claim another, holds its link here,
 * per project, until it claims one (`claimed`), and meanwhile stands in for the issue's linked
 * session. What changes a link says so (`changed`), for every tab of the project to show it.
 */
export class IssueLinks {
  /** Per project, each issue's tab that links its session once it has one. */
  private readonly waiting = new Map<string, Map<number, TabRef>>();

  constructor(
    private readonly dataRoot: string,
    /** Whether the tab is on the strip of its repository or worktree: a closed one waits no more. */
    private readonly isOpen: (at: TabRef) => boolean,
    private readonly changed: (projectId: string) => void,
  ) {}

  /** The project's waiting tabs, those closed meanwhile dropped. */
  private waitingOf(projectId: string): Map<number, TabRef> {
    let waiting = this.waiting.get(projectId);
    if (!waiting) {
      waiting = new Map();
      this.waiting.set(projectId, waiting);
    }
    for (const [number, at] of waiting) {
      if (!this.isOpen(at)) {
        waiting.delete(number);
      }
    }
    return waiting;
  }

  private waitedBy(waiting: Map<number, TabRef>, ref: ProjectRef, tabId: string): number | undefined {
    return [...waiting].find(([, at]) => isTab(at, ref, tabId))?.[0];
  }

  /** The issue each of the repository's or worktree's tabs shows, by its id: the one it waits for,
   *  else its session's, unless another tab waits for that issue. The store is read once, and not
   *  at all for tabs without a session. */
  issuesOf(ref: ProjectRef, tabs: readonly TabState[]): Map<string, number> {
    const waiting = this.waitingOf(ref.projectId);
    const issues = new Map<string, number>();
    for (const [number, at] of waiting) {
      if (sameProjectRef(at.ref, ref)) {
        issues.set(at.tabId, number);
      }
    }
    const sessions = new Map(tabs.flatMap((tab) => (tab.sessionId && !issues.has(tab.tabId) ? [[tab.sessionId, tab.tabId]] : [])));
    if (sessions.size === 0) {
      return issues;
    }
    for (const [number, link] of Object.entries(issueSessionLinks(this.dataRoot, ref.projectId))) {
      const tabId = sessions.get(link.sessionId);
      if (tabId !== undefined && sameProjectRef(link.ref, ref) && !waiting.has(Number(number))) {
        issues.set(tabId, Number(number));
      }
    }
    return issues;
  }

  /**
   * Links the tab to the issue in place of the issue's own session, taking it off any other issue:
   * its session where it has one, else the one it claims, waiting meanwhile. Answers what that changed
   * beside the link. Throws when the store cannot be written, nothing changed.
   */
  link(ref: ProjectRef, tabId: string, sessionId: string | undefined, number: number): IssueLinkChange {
    const waiting = this.waitingOf(ref.projectId);
    const waited = this.waitedBy(waiting, ref, tabId);
    const other = waiting.get(number);
    const displaced = other !== undefined && !isTab(other, ref, tabId);
    let change: IssueLinkChange;
    if (sessionId === undefined) {
      change = {
        ...(waited !== undefined && waited !== number && { movedFrom: waited }),
        ...((displaced || number in issueSessionLinks(this.dataRoot, ref.projectId)) && { replacedSession: true }),
      };
    } else {
      change = { ...linkIssueSession(this.dataRoot, ref, number, sessionId), ...(displaced && { replacedSession: true }) };
    }
    if (waited !== undefined) {
      waiting.delete(waited);
    }
    if (sessionId === undefined) {
      waiting.set(number, { ref, tabId });
    } else {
      waiting.delete(number);
    }
    this.changed(ref.projectId);
    return change;
  }

  /** Takes the tab, its session or its waiting, off the issue. Throws when the store cannot be
   *  written, nothing changed. */
  unlink(ref: ProjectRef, tabId: string, sessionId: string | undefined, number: number): void {
    if (sessionId !== undefined) {
      unlinkIssueSession(this.dataRoot, ref, number, sessionId);
    }
    const waiting = this.waitingOf(ref.projectId);
    const at = waiting.get(number);
    if (at && isTab(at, ref, tabId)) {
      waiting.delete(number);
    }
    this.changed(ref.projectId);
  }

  /** The tab claimed its session: the link it waited to make is made. A failure is logged, as the
   *  claim goes on. */
  claimed(ref: ProjectRef, tabId: string, sessionId: string): void {
    const waiting = this.waitingOf(ref.projectId);
    const number = this.waitedBy(waiting, ref, tabId);
    if (number === undefined) {
      return;
    }
    waiting.delete(number);
    logFailure("link a session to its issue", () => linkIssueSession(this.dataRoot, ref, number, sessionId));
    this.changed(ref.projectId);
  }
}
