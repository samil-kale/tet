import { holdsSeen, withSeen, type TrackedKind, type TrackedRef, type TrackedSeen } from "../../shared/types/providers";
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

/** A tab shows one as last changed at `updatedAt`, its checks `failed` or not: kept, and its section
 *  stops marking it. What is already kept is not sent again. */
export function keepSeen(projectId: string, tracked: TrackedRef, updatedAt: string, failed = false): void {
  const seen = seenByProject.get()[keyOf(tracked.kind, projectId)];
  if (seen && holdsSeen(seen, tracked.number, updatedAt, failed)) {
    return;
  }
  if (seen) {
    setSeen(tracked.kind, projectId, withSeen(seen, tracked.number, updatedAt, failed));
  }
  void window.tet.tracked.markSeen(projectId, tracked, updatedAt, failed);
}

/** It counts as unread again: kept as shown just before its `updatedAt`, so that `isUnread` holds
 *  until its tab shows it. */
export function keepUnread(projectId: string, tracked: TrackedRef, updatedAt: string): void {
  keepSeen(projectId, tracked, new Date(Date.parse(updatedAt) - 1).toISOString());
}

/** Every one of the kind read, from now on; a notice when that cannot be kept. */
export async function keepAllSeen(kind: TrackedKind, projectId: string): Promise<void> {
  const result = await window.tet.tracked.markAllSeen(projectId, kind);
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
