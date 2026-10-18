import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectRef } from "../../shared/types/project";
import { isRecord, logFailure, readJson, writeJson } from "../util/json-file";
import { closedFile } from "./project-dirs";

/** The file's key for the repository; a worktree's is its key (never "repository"). */
function keyOf(ref: ProjectRef): string {
  return ref.worktree ?? "repository";
}

/** The file as stored: session ids per repository or worktree, anything else dropped. */
function read(dataRoot: string, projectId: string): Record<string, string[]> {
  const parsed = readJson(closedFile(dataRoot, projectId));
  const stored: Record<string, string[]> = {};
  if (isRecord(parsed)) {
    for (const [key, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) {
        stored[key] = ids.filter((id): id is string => typeof id === "string");
      }
    }
  }
  return stored;
}

/** Writes the file without its empty entries, and removes it once none is left. Throws when it
 *  cannot. */
function write(dataRoot: string, projectId: string, stored: Record<string, string[]>): void {
  const file = closedFile(dataRoot, projectId);
  const kept = Object.fromEntries(Object.entries(stored).filter(([, ids]) => ids.length > 0));
  if (Object.keys(kept).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, kept);
}

/** The sessions kept closed in the repository or worktree: kept by the agent, shown by TET as a
 *  closed tab until reopened or deleted. */
export function closedIds(dataRoot: string, ref: ProjectRef): Set<string> {
  return new Set(read(dataRoot, ref.projectId)[keyOf(ref)]);
}

/** Keeps one session closed, or releases it. Throws when the file cannot be written, nothing changed. */
export function setClosed(dataRoot: string, ref: ProjectRef, sessionId: string, closed: boolean): void {
  const stored = read(dataRoot, ref.projectId);
  const ids = new Set(stored[keyOf(ref)]);
  if (closed === ids.has(sessionId)) {
    return;
  }
  if (closed) {
    ids.add(sessionId);
  } else {
    ids.delete(sessionId);
  }
  write(dataRoot, ref.projectId, { ...stored, [keyOf(ref)]: [...ids] });
}

/** A deleted worktree's entries. Left behind they are only unused, so a failure is logged. */
export function forgetClosed(dataRoot: string, ref: ProjectRef): void {
  logFailure("forget the closed sessions of a worktree", () => {
    const stored = read(dataRoot, ref.projectId);
    if (keyOf(ref) in stored) {
      write(dataRoot, ref.projectId, { ...stored, [keyOf(ref)]: [] });
    }
  });
}
