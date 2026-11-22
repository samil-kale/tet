import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectRef } from "../../shared/types/project";
import { TRACKED_KINDS, type TrackedKind } from "../../shared/types/providers";
import type { TrackedLinkChange } from "../../shared/types/terminals";
import { hasStrings, isRecord, logFailure, readJson, writeJson } from "../util/json-file";
import { entryKeyOf, refOfEntryKey, sessionLinksFile } from "./project-dirs";

/** A session linked to an issue or change request: where it lives (`entryKeyOf`), and its id. */
interface StoredLink {
  at: string;
  sessionId: string;
}

function isLink(value: unknown): value is StoredLink {
  return hasStrings(value, "at", "sessionId");
}

/** Whether the link names this session of the repository or worktree. */
function names(link: StoredLink, ref: ProjectRef, sessionId: string): boolean {
  return link.at === entryKeyOf(ref) && link.sessionId === sessionId;
}

/**
 * Each file as last read or written, by its path: every tab list a repository or worktree sends reads
 * its links. Only TET writes the files, each through `write`; a project's folder going takes its
 * entries with it (`dropCachedLinks`).
 */
const cached = new Map<string, Readonly<Record<string, StoredLink>>>();

/** The file as stored: the link per number, anything else dropped. */
function read(dataRoot: string, projectId: string, kind: TrackedKind): Readonly<Record<string, StoredLink>> {
  const file = sessionLinksFile(dataRoot, projectId, kind);
  const known = cached.get(file);
  if (known) {
    return known;
  }
  const parsed = readJson(file);
  const stored: Record<string, StoredLink> = {};
  if (isRecord(parsed)) {
    for (const [number, entry] of Object.entries(parsed)) {
      // A list per issue, as kept while an issue could have several sessions: its latest link
      // stands. Read until 2027-02-15.
      const link = Array.isArray(entry) ? entry.filter(isLink).at(-1) : isLink(entry) ? entry : undefined;
      if (/^\d+$/.test(number) && link) {
        stored[number] = { at: link.at, sessionId: link.sessionId };
      }
    }
  }
  cached.set(file, stored);
  return stored;
}

/** Writes the file, and removes it once no link is left. Throws when it cannot. */
function write(dataRoot: string, projectId: string, kind: TrackedKind, stored: Record<string, StoredLink>): void {
  const file = sessionLinksFile(dataRoot, projectId, kind);
  if (Object.keys(stored).length === 0) {
    fs.rmSync(file, { force: true });
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, stored);
  }
  cached.set(file, stored);
}

/** The project's files as read before, its folder deleted. */
export function dropCachedLinks(dataRoot: string, projectId: string): void {
  for (const kind of TRACKED_KINDS) {
    cached.delete(sessionLinksFile(dataRoot, projectId, kind));
  }
}

/** Every link kept but those `drop` names; written only when one goes. */
function dropLinks(dataRoot: string, projectId: string, kind: TrackedKind, drop: (number: string, link: StoredLink) => boolean): void {
  const stored = read(dataRoot, projectId, kind);
  const kept = Object.fromEntries(Object.entries(stored).filter(([number, link]) => !drop(number, link)));
  if (Object.keys(kept).length !== Object.keys(stored).length) {
    write(dataRoot, projectId, kind, kept);
  }
}

/**
 * The session linked to each of the project's issues or change requests: kept by the agent, shown in
 * the tab of what it is linked to by what the repository's or worktree's tabs say of it. One file per
 * project and kind, since its repository and worktrees share the host.
 */
export function sessionLinks(
  dataRoot: string,
  projectId: string,
  kind: TrackedKind,
): Record<number, { ref: ProjectRef; sessionId: string }> {
  return Object.fromEntries(
    Object.entries(read(dataRoot, projectId, kind)).map(([number, link]) => [
      Number(number),
      { ref: refOfEntryKey(projectId, link.at), sessionId: link.sessionId },
    ]),
  );
}

/** The issue or change request the session is linked to. */
export function linkedOfSession(dataRoot: string, ref: ProjectRef, kind: TrackedKind, sessionId: string): number | undefined {
  const entry = Object.entries(read(dataRoot, ref.projectId, kind)).find(([, link]) => names(link, ref, sessionId));
  return entry && Number(entry[0]);
}

/** Links the session to one in place of its own, and takes it off any other of the kind: one has one
 *  session, a session one of each kind. Answers what that changed beside the link. Throws when the file
 *  cannot be written, nothing changed. */
export function linkSession(dataRoot: string, ref: ProjectRef, kind: TrackedKind, number: number, sessionId: string): TrackedLinkChange {
  const kept: Record<string, StoredLink> = {};
  let movedFrom: number | undefined;
  for (const [entry, link] of Object.entries(read(dataRoot, ref.projectId, kind))) {
    if (Number(entry) !== number && names(link, ref, sessionId)) {
      movedFrom = Number(entry);
    } else {
      kept[entry] = link;
    }
  }
  const current = kept[number];
  if (current && names(current, ref, sessionId) && movedFrom === undefined) {
    return {};
  }
  const replacing = current !== undefined && !names(current, ref, sessionId);
  kept[number] = { at: entryKeyOf(ref), sessionId };
  write(dataRoot, ref.projectId, kind, kept);
  return { ...(movedFrom !== undefined && { movedFrom }), ...(replacing && { replacedSession: true }) };
}

/** Takes the session off one. Throws when the file cannot be written, nothing changed. */
export function unlinkSession(dataRoot: string, ref: ProjectRef, kind: TrackedKind, number: number, sessionId: string): void {
  dropLinks(dataRoot, ref.projectId, kind, (entry, link) => Number(entry) === number && names(link, ref, sessionId));
}

/** A deleted session's links, of both kinds. Left behind they are only unused, so a failure is logged. */
export function forgetSessionLinks(dataRoot: string, ref: ProjectRef, sessionId: string): void {
  for (const kind of TRACKED_KINDS) {
    logFailure(`forget the ${kind} of a deleted session`, () =>
      dropLinks(dataRoot, ref.projectId, kind, (_number, link) => names(link, ref, sessionId)),
    );
  }
}

/** A deleted worktree's links, of both kinds. Left behind they are only unused, so a failure is logged. */
export function forgetSessionLinksAt(dataRoot: string, ref: ProjectRef): void {
  const key = entryKeyOf(ref);
  for (const kind of TRACKED_KINDS) {
    logFailure(`forget the ${kind} links of a worktree`, () =>
      dropLinks(dataRoot, ref.projectId, kind, (_number, link) => link.at === key),
    );
  }
}

/** A deleted one's link. Left behind it is only unused, so a failure is logged. */
export function forgetLinkedSession(dataRoot: string, projectId: string, kind: TrackedKind, number: number): void {
  logFailure(`forget the session of a deleted ${kind}`, () => dropLinks(dataRoot, projectId, kind, (entry) => Number(entry) === number));
}

/** The whole file of a kind: its numbers name other ones once the source changed. Left behind it would
 *  show their sessions on them, so a failure is logged. */
export function forgetAllSessionLinks(dataRoot: string, projectId: string, kind: TrackedKind): void {
  logFailure(`forget the sessions of the project's ${kind}s`, () => write(dataRoot, projectId, kind, {}));
}

/** Drops the repository's or worktree's links to sessions not among `present`, of both kinds, as
 *  pruneArchived does: a session deleted outside TET left only this file's note of it behind. Left
 *  behind it is only unused, so a failure is logged. */
export function pruneSessionLinks(dataRoot: string, ref: ProjectRef, present: ReadonlySet<string>): void {
  const key = entryKeyOf(ref);
  for (const kind of TRACKED_KINDS) {
    logFailure(`prune the ${kind} links of a repository or worktree`, () =>
      dropLinks(dataRoot, ref.projectId, kind, (_number, link) => link.at === key && !present.has(link.sessionId)),
    );
  }
}
