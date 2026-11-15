import { useEffect, useSyncExternalStore } from "react";
import { sameProjectRef } from "../../shared/types/project";
import type { IssueSession } from "../../shared/types/terminals";
import { forget, stableRecord } from "../identity";
import { createStore } from "../ui/store";

/** The session linked to each of a project's issues that has one, by its number. */
export type IssueSessions = Readonly<Record<number, IssueSession>>;

const NONE: IssueSessions = {};

/** What every view watching a project shows of its issues' sessions (`issues.sessions`). */
const sessionsByProject = createStore<Record<string, IssueSessions>>({});

/** A project some view watches: how many do, what its last read handed out, and whether a read runs
 *  or another is due once it answers. */
interface Watched {
  views: number;
  held: { current: Record<string, IssueSession> };
  reading: boolean;
  due: boolean;
}

const watched = new Map<string, Watched>();
let unsubscribers: (() => void)[] = [];

/** An entry read again the same keeps its identity: `ref` comes as a new object every read. */
function sameSession(previous: IssueSession, next: IssueSession): boolean {
  return (
    sameProjectRef(previous.ref, next.ref) &&
    previous.worktree === next.worktree &&
    previous.tabId === next.tabId &&
    previous.agentId === next.agentId &&
    previous.title === next.title &&
    previous.archived === next.archived
  );
}

/** Reads a watched project's sessions, one read at a time: asked while one runs, one more follows it,
 *  however often it was asked. So answers land in order. */
function read(projectId: string): void {
  const entry = watched.get(projectId);
  if (!entry) {
    return;
  }
  if (entry.reading) {
    entry.due = true;
    return;
  }
  entry.reading = true;
  void window.tet.issues.sessions(projectId).then((result) => {
    // Unwatched meanwhile: a later watch is another entry.
    if (watched.get(projectId) !== entry) {
      return;
    }
    entry.reading = false;
    const sessions = stableRecord(entry.held, result.sessions ?? NONE, sameSession);
    if (sessions !== sessionsByProject.get()[projectId]) {
      sessionsByProject.set({ ...sessionsByProject.get(), [projectId]: sessions });
    }
    if (entry.due) {
      entry.due = false;
      read(projectId);
    }
  });
}

/** Reads the project's sessions now and whenever main says they changed, or a worktree's name did.
 *  Answers the unwatch. */
function watch(projectId: string): () => void {
  if (watched.size === 0) {
    unsubscribers = [
      window.tet.issues.onSessionsChanged(read),
      window.tet.projects.onChanged(() => watched.forEach((_entry, id) => read(id))),
    ];
  }
  const entry = watched.get(projectId);
  if (entry) {
    entry.views += 1;
  } else {
    watched.set(projectId, { views: 1, held: { current: {} }, reading: false, due: false });
    read(projectId);
  }
  return () => {
    const current = watched.get(projectId);
    if (!current || --current.views > 0) {
      return;
    }
    watched.delete(projectId);
    sessionsByProject.set(forget(sessionsByProject.get(), projectId));
    if (watched.size === 0) {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      unsubscribers = [];
    }
  };
}

/** Keeps the project's sessions read while the view is there, for `issueSessionsOf` to answer. */
export function useWatchedIssueSessions(projectId: string | undefined): void {
  useEffect(() => (projectId === undefined ? undefined : watch(projectId)), [projectId]);
}

/** What is read of the project's sessions now, for what asks only on demand, as a menu. None for no
 *  project. */
export function issueSessionsOf(projectId: string | undefined): IssueSessions {
  return (projectId !== undefined && sessionsByProject.get()[projectId]) || NONE;
}

/**
 * The session linked to each of the project's issues, as its tab shows it, read once for every view
 * watching the project; a change of another project's renders nothing here.
 */
export function useIssueSessions(projectId: string | undefined): IssueSessions {
  useWatchedIssueSessions(projectId);
  return useSyncExternalStore(sessionsByProject.subscribe, () => issueSessionsOf(projectId));
}
