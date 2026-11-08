import * as fs from "node:fs";
import * as path from "node:path";
import type { IssuesSeen } from "../../shared/types/providers";
import { logFailure, readJson, recordOf, writeJson } from "../util/json-file";
import { issuesSeenFile } from "./project-dirs";

/** The file as stored, one per project since its repository and worktrees share the tracker: issue
 *  numbers with their `updatedAt`, anything else dropped. */
export function readIssuesSeen(dataRoot: string, projectId: string): IssuesSeen {
  const seen: IssuesSeen = {};
  for (const [number, updatedAt] of Object.entries(recordOf(readJson(issuesSeenFile(dataRoot, projectId))))) {
    if (/^\d+$/.test(number) && typeof updatedAt === "string") {
      seen[Number(number)] = updatedAt;
    }
  }
  return seen;
}

/** Writes the file, or removes it once none is left. Throws when it cannot. */
function write(dataRoot: string, projectId: string, seen: IssuesSeen): void {
  const file = issuesSeenFile(dataRoot, projectId);
  if (Object.keys(seen).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, seen);
}

/** Keeps the issue's `updatedAt` as its tab showed it. Throws when the file cannot be written,
 *  nothing changed. */
export function setIssueSeen(dataRoot: string, projectId: string, number: number, updatedAt: string): void {
  const seen = readIssuesSeen(dataRoot, projectId);
  if (seen[number] !== updatedAt) {
    write(dataRoot, projectId, { ...seen, [number]: updatedAt });
  }
}

/** A deleted issue's entry. Left behind it is only unused, so a failure is logged. */
export function forgetIssueSeen(dataRoot: string, projectId: string, number: number): void {
  logFailure("forget a deleted issue's last seen update", () => {
    const kept = Object.entries(readIssuesSeen(dataRoot, projectId)).filter(([entry]) => Number(entry) !== number);
    write(dataRoot, projectId, Object.fromEntries(kept));
  });
}

/** Every entry of the project: its issue numbers name other issues once the source changed. Left
 *  behind they would mark them, so a failure is logged. */
export function forgetAllIssuesSeen(dataRoot: string, projectId: string): void {
  logFailure("forget the last seen updates of the project's issues", () => write(dataRoot, projectId, {}));
}
