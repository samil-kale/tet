import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectRef } from "../../shared/types/project";
import { isRecord, logFailure, readJson, writeJson } from "../util/json-file";
import { archiveFile } from "./project-dirs";

/** The file's key for the repository; a worktree's is its key (never "repository"). */
function keyOf(ref: ProjectRef): string {
  return ref.worktree ?? "repository";
}

/** The file as stored: session ids per repository or worktree, anything else dropped. */
function read(dataRoot: string, projectId: string): Record<string, string[]> {
  const parsed = readJson(archiveFile(dataRoot, projectId));
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
  const file = archiveFile(dataRoot, projectId);
  const kept = Object.fromEntries(Object.entries(stored).filter(([, ids]) => ids.length > 0));
  if (Object.keys(kept).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, kept);
}

/** The sessions kept archived in the repository or worktree, in the ARCHIVE lane's own order
 *  (newest archived, or dragged, first): kept by the agent, shown by TET as an archived tab until
 *  reopened or deleted. */
export function archivedIds(dataRoot: string, ref: ProjectRef): string[] {
  return read(dataRoot, ref.projectId)[keyOf(ref)] ?? [];
}

/** Keeps one session archived, placed on top as the newest, or releases it. Throws when the file
 *  cannot be written, nothing changed. */
export function setArchived(dataRoot: string, ref: ProjectRef, sessionId: string, archived: boolean): void {
  const stored = read(dataRoot, ref.projectId);
  const key = keyOf(ref);
  const ids = stored[key] ?? [];
  if (archived === ids.includes(sessionId)) {
    return;
  }
  const next = archived ? [sessionId, ...ids] : ids.filter((id) => id !== sessionId);
  write(dataRoot, ref.projectId, { ...stored, [key]: next });
}

/** A drag in the ARCHIVE lane: `order` becomes the stored order, any id no longer archived
 *  dropped. Throws when the file cannot be written, nothing changed. */
export function setArchivedOrder(dataRoot: string, ref: ProjectRef, order: string[]): void {
  const stored = read(dataRoot, ref.projectId);
  const key = keyOf(ref);
  const current = new Set(stored[key]);
  write(dataRoot, ref.projectId, { ...stored, [key]: order.filter((id) => current.has(id)) });
}

/** A deleted worktree's entries. Left behind they are only unused, so a failure is logged. */
export function forgetArchived(dataRoot: string, ref: ProjectRef): void {
  logFailure("forget the archived sessions of a worktree", () => {
    const stored = read(dataRoot, ref.projectId);
    if (keyOf(ref) in stored) {
      write(dataRoot, ref.projectId, { ...stored, [keyOf(ref)]: [] });
    }
  });
}

/** Drops ids not among `present` (TabSessionManager.bootstrap, once every agent with sessions
 *  could be listed): a session deleted outside TET left only this file's note of it behind. Left
 *  behind it is only unused, so a failure is logged. */
export function pruneArchived(dataRoot: string, ref: ProjectRef, present: ReadonlySet<string>): void {
  logFailure("prune the archived sessions of a repository or worktree", () => {
    const stored = read(dataRoot, ref.projectId);
    const key = keyOf(ref);
    const ids = stored[key];
    const kept = ids?.filter((id) => present.has(id)) ?? [];
    if (kept.length !== (ids?.length ?? 0)) {
      write(dataRoot, ref.projectId, { ...stored, [key]: kept });
    }
  });
}
