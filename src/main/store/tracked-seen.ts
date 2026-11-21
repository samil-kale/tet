import * as fs from "node:fs";
import * as path from "node:path";
import type { TrackedKind, TrackedSeen } from "../../shared/types/providers";
import { logFailure, readJson, recordOf, writeJson } from "../util/json-file";
import { seenFile } from "./project-dirs";

/** What the file keeps each one's `updatedAt` under, per kind. */
const SHOWN_KEYS: Record<TrackedKind, string> = { issue: "issues", "change-request": "changeRequests" };

/** Writes the file. Throws when it cannot. */
function write(dataRoot: string, projectId: string, kind: TrackedKind, seen: TrackedSeen): void {
  const file = seenFile(dataRoot, projectId, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, { since: seen.since, [SHOWN_KEYS[kind]]: seen.shown, ...(seen.failed && { failed: seen.failed }) });
}

/** What the project's tabs of one kind showed, one file per project and kind since its repository and
 *  worktrees share the host; anything else in it is dropped. A project without one counts from now:
 *  what the host held before is read, and the file starts here. */
export function readSeen(dataRoot: string, projectId: string, kind: TrackedKind): TrackedSeen {
  const stored = recordOf(readJson(seenFile(dataRoot, projectId, kind)));
  const shown: TrackedSeen["shown"] = {};
  for (const [number, updatedAt] of Object.entries(recordOf(stored[SHOWN_KEYS[kind]]))) {
    if (/^\d+$/.test(number) && typeof updatedAt === "string") {
      shown[Number(number)] = updatedAt;
    }
  }
  const failed = Array.isArray(stored.failed) ? stored.failed.filter((number) => Number.isInteger(number)) : [];
  const kept = kind === "change-request" ? { failed: failed as number[] } : {};
  if (typeof stored.since === "string") {
    return { since: stored.since, shown, ...kept };
  }
  const seen = { since: new Date().toISOString(), shown, ...kept };
  logFailure(`start counting the project's unread ${kind}s`, () => write(dataRoot, projectId, kind, seen));
  return seen;
}

/** Keeps one's `updatedAt` as its tab showed it, and for a change request whether its checks had
 *  failed. Throws when the file cannot be written, nothing changed. */
export function setSeen(dataRoot: string, projectId: string, kind: TrackedKind, number: number, updatedAt: string, failed = false): void {
  const seen = readSeen(dataRoot, projectId, kind);
  const wasFailed = (seen.failed ?? []).includes(number);
  const failedChanged = kind === "change-request" && wasFailed !== failed;
  if (seen.shown[number] !== updatedAt || failedChanged) {
    write(dataRoot, projectId, kind, {
      ...seen,
      shown: { ...seen.shown, [number]: updatedAt },
      ...(failedChanged && { failed: failed ? [...(seen.failed ?? []), number] : (seen.failed ?? []).filter((entry) => entry !== number) }),
    });
  }
}

/** Every one read: the project counts from now, the entries before it dropped. Throws when the file
 *  cannot be written, nothing changed. */
export function markAllSeen(dataRoot: string, projectId: string, kind: TrackedKind): TrackedSeen {
  const seen: TrackedSeen = { since: new Date().toISOString(), shown: {}, ...(kind === "change-request" && { failed: [] }) };
  write(dataRoot, projectId, kind, seen);
  return seen;
}

/** A deleted one's entry. Left behind it is only unused, so a failure is logged. */
export function forgetSeen(dataRoot: string, projectId: string, kind: TrackedKind, number: number): void {
  logFailure(`forget a deleted ${kind}'s last seen update`, () => {
    const seen = readSeen(dataRoot, projectId, kind);
    if (number in seen.shown || (seen.failed ?? []).includes(number)) {
      const kept = Object.entries(seen.shown).filter(([entry]) => Number(entry) !== number);
      write(dataRoot, projectId, kind, {
        ...seen,
        shown: Object.fromEntries(kept),
        ...(seen.failed && { failed: seen.failed.filter((entry) => entry !== number) }),
      });
    }
  });
}

/** The whole file: its numbers name other ones once the source changed, and the next read starts the
 *  project afresh. Left behind it would mark them, so a failure is logged. */
export function forgetAllSeen(dataRoot: string, projectId: string, kind: TrackedKind): void {
  logFailure(`forget the last seen updates of the project's ${kind}s`, () =>
    fs.rmSync(seenFile(dataRoot, projectId, kind), { force: true }),
  );
}
