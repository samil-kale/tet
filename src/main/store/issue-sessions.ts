import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectRef } from "../../shared/types/project";
import type { IssueLinkChange } from "../../shared/types/terminals";
import { hasStrings, isRecord, logFailure, readJson, writeJson } from "../util/json-file";
import { entryKeyOf, issueSessionsFile, refOfEntryKey } from "./project-dirs";

/** A session linked to an issue: where it lives (`entryKeyOf`), and its id. */
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

/** The file as stored: the link per issue number, anything else dropped. */
function read(dataRoot: string, projectId: string): Record<string, StoredLink> {
  const parsed = readJson(issueSessionsFile(dataRoot, projectId));
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
  return stored;
}

/** Writes the file, and removes it once no link is left. Throws when it cannot. */
function write(dataRoot: string, projectId: string, stored: Record<string, StoredLink>): void {
  const file = issueSessionsFile(dataRoot, projectId);
  if (Object.keys(stored).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, stored);
}

/** Every link kept but those `drop` names; written only when one goes. */
function dropLinks(dataRoot: string, projectId: string, drop: (number: string, link: StoredLink) => boolean): void {
  const stored = read(dataRoot, projectId);
  const kept = Object.fromEntries(Object.entries(stored).filter(([number, link]) => !drop(number, link)));
  if (Object.keys(kept).length !== Object.keys(stored).length) {
    write(dataRoot, projectId, kept);
  }
}

/**
 * The session linked to each of the project's issues: kept by the agent, shown in the issue's tab
 * by what the repository's or worktree's tabs say of it. One file per project, since its repository
 * and worktrees share the tracker.
 */
export function issueSessionLinks(dataRoot: string, projectId: string): Record<number, { ref: ProjectRef; sessionId: string }> {
  return Object.fromEntries(
    Object.entries(read(dataRoot, projectId)).map(([number, link]) => [
      Number(number),
      { ref: refOfEntryKey(projectId, link.at), sessionId: link.sessionId },
    ]),
  );
}

/** The issue the session is linked to. */
export function issueOfSession(dataRoot: string, ref: ProjectRef, sessionId: string): number | undefined {
  const entry = Object.entries(read(dataRoot, ref.projectId)).find(([, link]) => names(link, ref, sessionId));
  return entry && Number(entry[0]);
}

/** Links the session to the issue in place of the issue's own, and takes it off any other issue: an
 *  issue has one session, a session one issue. Answers what that changed beside the link. Throws
 *  when the file cannot be written, nothing changed. */
export function linkIssueSession(dataRoot: string, ref: ProjectRef, number: number, sessionId: string): IssueLinkChange {
  const kept: Record<string, StoredLink> = {};
  let movedFrom: number | undefined;
  for (const [entry, link] of Object.entries(read(dataRoot, ref.projectId))) {
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
  write(dataRoot, ref.projectId, kept);
  return { ...(movedFrom !== undefined && { movedFrom }), ...(replacing && { replacedSession: true }) };
}

/** Takes the session off the issue. Throws when the file cannot be written, nothing changed. */
export function unlinkIssueSession(dataRoot: string, ref: ProjectRef, number: number, sessionId: string): void {
  dropLinks(dataRoot, ref.projectId, (entry, link) => Number(entry) === number && names(link, ref, sessionId));
}

/** A deleted session's link. Left behind it is only unused, so a failure is logged. */
export function forgetSessionIssue(dataRoot: string, ref: ProjectRef, sessionId: string): void {
  logFailure("forget the issue of a deleted session", () =>
    dropLinks(dataRoot, ref.projectId, (_number, link) => names(link, ref, sessionId)),
  );
}

/** A deleted worktree's links. Left behind they are only unused, so a failure is logged. */
export function forgetIssueSessionsAt(dataRoot: string, ref: ProjectRef): void {
  const key = entryKeyOf(ref);
  logFailure("forget the issue links of a worktree", () => dropLinks(dataRoot, ref.projectId, (_number, link) => link.at === key));
}

/** A deleted issue's link. Left behind it is only unused, so a failure is logged. */
export function forgetIssueSession(dataRoot: string, projectId: string, number: number): void {
  logFailure("forget the session of a deleted issue", () => dropLinks(dataRoot, projectId, (entry) => Number(entry) === number));
}

/** The whole file: its issue numbers name other issues once the source changed. Left behind it would
 *  show their sessions on them, so a failure is logged. */
export function forgetAllIssueSessions(dataRoot: string, projectId: string): void {
  logFailure("forget the sessions of the project's issues", () => fs.rmSync(issueSessionsFile(dataRoot, projectId), { force: true }));
}

/** Drops the repository's or worktree's links to sessions not among `present`, as pruneArchived
 *  does: a session deleted outside TET left only this file's note of it behind. Left behind it is
 *  only unused, so a failure is logged. */
export function pruneIssueSessions(dataRoot: string, ref: ProjectRef, present: ReadonlySet<string>): void {
  const key = entryKeyOf(ref);
  logFailure("prune the issue links of a repository or worktree", () =>
    dropLinks(dataRoot, ref.projectId, (_number, link) => link.at === key && !present.has(link.sessionId)),
  );
}
