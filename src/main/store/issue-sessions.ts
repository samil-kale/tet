import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectRef } from "../../shared/types/project";
import { isRecord, logFailure, readJson, writeJson } from "../util/json-file";
import { entryKeyOf, issueSessionsFile, refOfEntryKey } from "./project-dirs";

/** A session linked to an issue: where it lives (`entryKeyOf`), and its id. */
interface StoredLink {
  at: string;
  sessionId: string;
}

/** Whether the link names this session of the repository or worktree. */
function names(link: StoredLink, ref: ProjectRef, sessionId: string): boolean {
  return link.at === entryKeyOf(ref) && link.sessionId === sessionId;
}

/** The file as stored: the links per issue number, anything else dropped. */
function read(dataRoot: string, projectId: string): Record<string, StoredLink[]> {
  const parsed = readJson(issueSessionsFile(dataRoot, projectId));
  const stored: Record<string, StoredLink[]> = {};
  if (isRecord(parsed)) {
    for (const [number, links] of Object.entries(parsed)) {
      if (/^\d+$/.test(number) && Array.isArray(links)) {
        stored[number] = links.filter(
          (link): link is StoredLink => isRecord(link) && typeof link.at === "string" && typeof link.sessionId === "string",
        );
      }
    }
  }
  return stored;
}

/** Writes the file without its empty entries, and removes it once none is left. Throws when it
 *  cannot. */
function write(dataRoot: string, projectId: string, stored: Record<string, StoredLink[]>): void {
  const file = issueSessionsFile(dataRoot, projectId);
  const kept = Object.fromEntries(Object.entries(stored).filter(([, links]) => links.length > 0));
  if (Object.keys(kept).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, kept);
}

/** Every link kept but those `drop` names; written only when one goes. */
function dropLinks(dataRoot: string, projectId: string, drop: (number: string, link: StoredLink) => boolean): void {
  const stored = read(dataRoot, projectId);
  let dropped = false;
  const kept = Object.fromEntries(
    Object.entries(stored).map(([number, links]) => {
      const rest = links.filter((link) => !drop(number, link));
      dropped ||= rest.length !== links.length;
      return [number, rest];
    }),
  );
  if (dropped) {
    write(dataRoot, projectId, kept);
  }
}

/**
 * The sessions linked to the project's issue, oldest link first: kept by the agent, shown in the
 * issue's tab by what the repository's or worktree's tabs say of them. One file per project, since
 * its repository and worktrees share the tracker.
 */
export function issueSessionLinks(dataRoot: string, projectId: string, number: number): { ref: ProjectRef; sessionId: string }[] {
  return (read(dataRoot, projectId)[number] ?? []).map((link) => ({
    ref: refOfEntryKey(projectId, link.at),
    sessionId: link.sessionId,
  }));
}

/** The issues the session is linked to. */
export function issuesOfSession(dataRoot: string, ref: ProjectRef, sessionId: string): number[] {
  return Object.entries(read(dataRoot, ref.projectId))
    .filter(([, links]) => links.some((link) => names(link, ref, sessionId)))
    .map(([number]) => Number(number));
}

/** Links the session to the issue, after the ones linked before. Throws when the file cannot be
 *  written, nothing changed. */
export function linkIssueSession(dataRoot: string, ref: ProjectRef, number: number, sessionId: string): void {
  const stored = read(dataRoot, ref.projectId);
  const links = stored[number] ?? [];
  if (links.some((link) => names(link, ref, sessionId))) {
    return;
  }
  write(dataRoot, ref.projectId, { ...stored, [number]: [...links, { at: entryKeyOf(ref), sessionId }] });
}

/** Takes the session off the issue. Throws when the file cannot be written, nothing changed. */
export function unlinkIssueSession(dataRoot: string, ref: ProjectRef, number: number, sessionId: string): void {
  dropLinks(dataRoot, ref.projectId, (entry, link) => Number(entry) === number && names(link, ref, sessionId));
}

/** A deleted session's links. Left behind they are only unused, so a failure is logged. */
export function forgetSessionIssues(dataRoot: string, ref: ProjectRef, sessionId: string): void {
  logFailure("forget the issues of a deleted session", () =>
    dropLinks(dataRoot, ref.projectId, (_number, link) => names(link, ref, sessionId)),
  );
}

/** A deleted worktree's links. Left behind they are only unused, so a failure is logged. */
export function forgetIssueSessionsAt(dataRoot: string, ref: ProjectRef): void {
  const key = entryKeyOf(ref);
  logFailure("forget the issue links of a worktree", () => dropLinks(dataRoot, ref.projectId, (_number, link) => link.at === key));
}

/** A deleted issue's links. Left behind they are only unused, so a failure is logged. */
export function forgetIssueSessions(dataRoot: string, projectId: string, number: number): void {
  logFailure("forget the sessions of a deleted issue", () => dropLinks(dataRoot, projectId, (entry) => Number(entry) === number));
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
