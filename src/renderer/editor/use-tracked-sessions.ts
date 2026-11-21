import { useEffect, useSyncExternalStore } from "react";
import { sameProjectRef } from "../../shared/types/project";
import type { TrackedKind } from "../../shared/types/providers";
import type { IssueSession } from "../../shared/types/terminals";
import { forget, stableRecord } from "../identity";
import { createStore } from "../ui/store";

/** The session linked to each of a project's issues or change requests that has one, by its number. */
export type TrackedSessions = Readonly<Record<number, IssueSession>>;

const NONE: TrackedSessions = {};

/** What every view watching a project shows of its sessions, by kind and project (`issues.sessions`,
 *  `changeRequests.sessions`). */
const sessionsByProject = createStore<Record<string, TrackedSessions>>({});

/** A project some view watches for one kind: how many do, what its last read handed out, and whether
 *  a read runs or another is due once it answers. */
interface Watched {
  kind: TrackedKind;
  projectId: string;
  views: number;
  held: { current: Record<string, IssueSession> };
  reading: boolean;
  due: boolean;
}

const watched = new Map<string, Watched>();
let unsubscribers: (() => void)[] = [];

function keyOf(kind: TrackedKind, projectId: string): string {
  return `${kind}\u0000${projectId}`;
}

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

/** Reads a watched project's sessions of one kind, one read at a time: asked while one runs, one more
 *  follows it, however often it was asked. So answers land in order. */
function read(key: string): void {
  const entry = watched.get(key);
  if (!entry) {
    return;
  }
  if (entry.reading) {
    entry.due = true;
    return;
  }
  entry.reading = true;
  const asked = entry.kind === "issue" ? window.tet.issues.sessions(entry.projectId) : window.tet.changeRequests.sessions(entry.projectId);
  void asked.then((result) => {
    // Unwatched meanwhile: a later watch is another entry.
    if (watched.get(key) !== entry) {
      return;
    }
    entry.reading = false;
    const sessions = stableRecord(entry.held, result.sessions ?? NONE, sameSession);
    if (sessions !== sessionsByProject.get()[key]) {
      sessionsByProject.set({ ...sessionsByProject.get(), [key]: sessions });
    }
    if (entry.due) {
      entry.due = false;
      read(key);
    }
  });
}

/** Reads the project's sessions of the kind now and whenever main says they changed, or a worktree's
 *  name did. Answers the unwatch. */
function watch(kind: TrackedKind, projectId: string): () => void {
  if (watched.size === 0) {
    unsubscribers = [
      window.tet.issues.onSessionsChanged((changed) =>
        watched.forEach((entry, key) => {
          if (entry.projectId === changed) {
            read(key);
          }
        }),
      ),
      window.tet.projects.onChanged(() => watched.forEach((_entry, key) => read(key))),
    ];
  }
  const key = keyOf(kind, projectId);
  const entry = watched.get(key);
  if (entry) {
    entry.views += 1;
  } else {
    watched.set(key, { kind, projectId, views: 1, held: { current: {} }, reading: false, due: false });
    read(key);
  }
  return () => {
    const current = watched.get(key);
    if (!current || --current.views > 0) {
      return;
    }
    watched.delete(key);
    sessionsByProject.set(forget(sessionsByProject.get(), key));
    if (watched.size === 0) {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      unsubscribers = [];
    }
  };
}

/** Keeps the project's sessions of the kind read while the view is there, for `trackedSessionsOf` to
 *  answer. */
export function useWatchedSessions(kind: TrackedKind, projectId: string | undefined): void {
  useEffect(() => (projectId === undefined ? undefined : watch(kind, projectId)), [kind, projectId]);
}

/** What is read of the project's sessions of the kind now, for what asks only on demand, as a menu.
 *  None for no project. */
export function trackedSessionsOf(kind: TrackedKind, projectId: string | undefined): TrackedSessions {
  return (projectId !== undefined && sessionsByProject.get()[keyOf(kind, projectId)]) || NONE;
}

/**
 * The session linked to each of the project's issues or change requests, as its tab shows it, read once
 * for every view watching the project; a change of another project's renders nothing here.
 */
export function useTrackedSessions(kind: TrackedKind, projectId: string | undefined): TrackedSessions {
  useWatchedSessions(kind, projectId);
  return useSyncExternalStore(sessionsByProject.subscribe, () => trackedSessionsOf(kind, projectId));
}
