import * as fs from "node:fs";
import * as path from "node:path";
import type { IssuesSeen } from "../../shared/types/providers";
import { logFailure, readJson, recordOf, writeJson } from "../util/json-file";
import { issuesSeenFile } from "./project-dirs";

/** Writes the file. Throws when it cannot. */
function write(dataRoot: string, projectId: string, seen: IssuesSeen): void {
  const file = issuesSeenFile(dataRoot, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, seen);
}

/** What the project's issue tabs showed, one file per project since its repository and worktrees
 *  share the tracker; anything else in it is dropped. A project without one counts from now: what
 *  the tracker held before is read, and the file starts here. */
export function readIssuesSeen(dataRoot: string, projectId: string): IssuesSeen {
  const stored = recordOf(readJson(issuesSeenFile(dataRoot, projectId)));
  const issues: IssuesSeen["issues"] = {};
  for (const [number, updatedAt] of Object.entries(recordOf(stored.issues))) {
    if (/^\d+$/.test(number) && typeof updatedAt === "string") {
      issues[Number(number)] = updatedAt;
    }
  }
  if (typeof stored.since === "string") {
    return { since: stored.since, issues };
  }
  const seen = { since: new Date().toISOString(), issues };
  logFailure("start counting the project's unread issues", () => write(dataRoot, projectId, seen));
  return seen;
}

/** Keeps the issue's `updatedAt` as its tab showed it. Throws when the file cannot be written,
 *  nothing changed. */
export function setIssueSeen(dataRoot: string, projectId: string, number: number, updatedAt: string): void {
  const seen = readIssuesSeen(dataRoot, projectId);
  if (seen.issues[number] !== updatedAt) {
    write(dataRoot, projectId, { ...seen, issues: { ...seen.issues, [number]: updatedAt } });
  }
}

/** Every issue read: the project counts from now, the entries before it dropped. Throws when the
 *  file cannot be written, nothing changed. */
export function markAllIssuesSeen(dataRoot: string, projectId: string): IssuesSeen {
  const seen = { since: new Date().toISOString(), issues: {} };
  write(dataRoot, projectId, seen);
  return seen;
}

/** A deleted issue's entry. Left behind it is only unused, so a failure is logged. */
export function forgetIssueSeen(dataRoot: string, projectId: string, number: number): void {
  logFailure("forget a deleted issue's last seen update", () => {
    const seen = readIssuesSeen(dataRoot, projectId);
    if (number in seen.issues) {
      const kept = Object.entries(seen.issues).filter(([entry]) => Number(entry) !== number);
      write(dataRoot, projectId, { ...seen, issues: Object.fromEntries(kept) });
    }
  });
}

/** The whole file: its issue numbers name other issues once the source changed, and the next read
 *  starts the project afresh. Left behind it would mark them, so a failure is logged. */
export function forgetAllIssuesSeen(dataRoot: string, projectId: string): void {
  logFailure("forget the last seen updates of the project's issues", () => fs.rmSync(issuesSeenFile(dataRoot, projectId), { force: true }));
}
