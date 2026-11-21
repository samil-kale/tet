import type { TrackedKind, TrackedSeen } from "../../shared/types/providers";
import { notify } from "../ui/Notices";
import { createStore, useStore } from "../ui/store";

/** What the tabs showed of each project's issues and change requests, by kind and project: what the
 *  file held when the list was read, since then what `keepSeen` and `keepAllSeen` kept. */
const seenByProject = createStore<Record<string, TrackedSeen>>({});

function keyOf(kind: TrackedKind, projectId: string): string {
  return `${kind}\u0000${projectId}`;
}

/** The project's list came with what the file holds. */
export function setSeen(kind: TrackedKind, projectId: string, seen: TrackedSeen): void {
  seenByProject.set({ ...seenByProject.get(), [keyOf(kind, projectId)]: seen });
}

/** A tab shows one as last changed at `updatedAt`, a change request with its checks `failed` or not:
 *  kept, and its section stops marking it. What is already kept is not sent again. */
export function keepSeen(kind: TrackedKind, projectId: string, number: number, updatedAt: string, failed = false): void {
  const seen = seenByProject.get()[keyOf(kind, projectId)];
  const wasFailed = (seen?.failed ?? []).includes(number);
  if (seen?.shown[number] === updatedAt && (kind === "issue" || wasFailed === failed)) {
    return;
  }
  if (seen) {
    const others = (seen.failed ?? []).filter((entry) => entry !== number);
    setSeen(kind, projectId, {
      ...seen,
      shown: { ...seen.shown, [number]: updatedAt },
      ...(kind === "change-request" && { failed: failed ? [...others, number] : others }),
    });
  }
  void (kind === "issue"
    ? window.tet.issues.markSeen(projectId, number, updatedAt)
    : window.tet.changeRequests.markSeen(projectId, number, updatedAt, failed));
}

/** It counts as unread again: kept as shown just before its `updatedAt`, so that `isUnread` holds
 *  until its tab shows it. */
export function keepUnread(kind: TrackedKind, projectId: string, number: number, updatedAt: string): void {
  keepSeen(kind, projectId, number, new Date(Date.parse(updatedAt) - 1).toISOString());
}

/** Every one of the kind read, from now on; a notice when that cannot be kept. */
export async function keepAllSeen(kind: TrackedKind, projectId: string): Promise<void> {
  const result = await (kind === "issue" ? window.tet.issues.markAllSeen(projectId) : window.tet.changeRequests.markAllSeen(projectId));
  if (result.ok) {
    setSeen(kind, projectId, result.seen);
  } else {
    notify("error", result.error);
  }
}

/** Undefined until the project's list of the kind was read. */
export function useSeen(kind: TrackedKind, projectId: string): TrackedSeen | undefined {
  return useStore(seenByProject)[keyOf(kind, projectId)];
}
