import { sameProjectRef, type ProjectRef } from "../../shared/types/project";
import type { TrackedKind } from "../../shared/types/providers";
import type { IssueLinkChange, TabRef } from "../../shared/types/terminals";
import { linkSession, sessionLinks, unlinkSession } from "../store/session-links";
import { logFailure } from "../util/json-file";
import type { TabState } from "./tab-state";

const KINDS: readonly TrackedKind[] = ["issue", "change-request"];

function isTab(at: TabRef, ref: ProjectRef, tabId: string): boolean {
  return at.tabId === tabId && sameProjectRef(at.ref, ref);
}

/**
 * Every link between the project's issues and change requests and its sessions, in the repository and
 * its worktrees alike: each has one session, a session one of each kind. A session's link is kept by
 * the store (session-links.ts); a tab that has no session yet, or waits to claim another, holds its
 * link here, per project and kind, until it claims one (`claimed`), and meanwhile stands in for the
 * linked session. What changes a link says so (`changed`), for every tab of the project to show it.
 */
export class TrackedLinks {
  /** Per kind and project, each one's tab that links its session once it has one. */
  private readonly waiting = new Map<string, Map<number, TabRef>>();

  constructor(
    private readonly dataRoot: string,
    /** Whether the tab is on the strip of its repository or worktree: a closed one waits no more. */
    private readonly isOpen: (at: TabRef) => boolean,
    private readonly changed: (projectId: string) => void,
  ) {}

  /** The project's waiting tabs of the kind, those closed meanwhile dropped. */
  private waitingOf(projectId: string, kind: TrackedKind): Map<number, TabRef> {
    const key = `${kind}\u0000${projectId}`;
    let waiting = this.waiting.get(key);
    if (!waiting) {
      waiting = new Map();
      this.waiting.set(key, waiting);
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

  /** The one of the kind each of the repository's or worktree's tabs shows, by its id: the one it
   *  waits for, else its session's, unless another tab waits for that one. The store is read once,
   *  and not at all for tabs without a session. */
  linksOf(ref: ProjectRef, tabs: readonly TabState[], kind: TrackedKind): Map<string, number> {
    const waiting = this.waitingOf(ref.projectId, kind);
    const linked = new Map<string, number>();
    for (const [number, at] of waiting) {
      if (sameProjectRef(at.ref, ref)) {
        linked.set(at.tabId, number);
      }
    }
    const sessions = new Map(tabs.flatMap((tab) => (tab.sessionId && !linked.has(tab.tabId) ? [[tab.sessionId, tab.tabId]] : [])));
    if (sessions.size === 0) {
      return linked;
    }
    for (const [number, link] of Object.entries(sessionLinks(this.dataRoot, ref.projectId, kind))) {
      const tabId = sessions.get(link.sessionId);
      if (tabId !== undefined && sameProjectRef(link.ref, ref) && !waiting.has(Number(number))) {
        linked.set(tabId, Number(number));
      }
    }
    return linked;
  }

  /**
   * Links the tab to one of the kind in place of its own session, taking it off any other of the kind:
   * its session where it has one, else the one it claims, waiting meanwhile. Answers what that changed
   * beside the link. Throws when the store cannot be written, nothing changed.
   */
  link(ref: ProjectRef, tabId: string, sessionId: string | undefined, kind: TrackedKind, number: number): IssueLinkChange {
    const waiting = this.waitingOf(ref.projectId, kind);
    const waited = this.waitedBy(waiting, ref, tabId);
    const other = waiting.get(number);
    const displaced = other !== undefined && !isTab(other, ref, tabId);
    let change: IssueLinkChange;
    if (sessionId === undefined) {
      change = {
        ...(waited !== undefined && waited !== number && { movedFrom: waited }),
        ...((displaced || number in sessionLinks(this.dataRoot, ref.projectId, kind)) && { replacedSession: true }),
      };
    } else {
      change = { ...linkSession(this.dataRoot, ref, kind, number, sessionId), ...(displaced && { replacedSession: true }) };
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

  /** Takes the tab, its session or its waiting, off one of the kind. Throws when the store cannot be
   *  written, nothing changed. */
  unlink(ref: ProjectRef, tabId: string, sessionId: string | undefined, kind: TrackedKind, number: number): void {
    if (sessionId !== undefined) {
      unlinkSession(this.dataRoot, ref, kind, number, sessionId);
    }
    const waiting = this.waitingOf(ref.projectId, kind);
    const at = waiting.get(number);
    if (at && isTab(at, ref, tabId)) {
      waiting.delete(number);
    }
    this.changed(ref.projectId);
  }

  /** The tab claimed its session: the links it waited to make, of either kind, are made. A failure is
   *  logged, as the claim goes on. */
  claimed(ref: ProjectRef, tabId: string, sessionId: string): void {
    let made = false;
    for (const kind of KINDS) {
      const waiting = this.waitingOf(ref.projectId, kind);
      const number = this.waitedBy(waiting, ref, tabId);
      if (number !== undefined) {
        waiting.delete(number);
        logFailure(`link a session to its ${kind}`, () => linkSession(this.dataRoot, ref, kind, number, sessionId));
        made = true;
      }
    }
    if (made) {
      this.changed(ref.projectId);
    }
  }
}
