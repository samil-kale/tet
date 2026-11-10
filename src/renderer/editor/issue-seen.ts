import type { IssuesSeen } from "../../shared/types/providers";
import { notify } from "../ui/Notices";
import { createStore, useStore } from "../ui/store";

/** What the tabs showed of each project's issues: what the file held when the list was read, since
 *  then what `keepIssueSeen` and `keepAllIssuesSeen` kept. */
const seenByProject = createStore<Record<string, IssuesSeen>>({});

/** The project's list came with what the file holds. */
export function setIssuesSeen(projectId: string, seen: IssuesSeen): void {
  seenByProject.set({ ...seenByProject.get(), [projectId]: seen });
}

/** An issue's tab shows it as last changed at `updatedAt`: kept, and the ISSUES section stops marking
 *  it. What is already kept is not sent again. */
export function keepIssueSeen(projectId: string, number: number, updatedAt: string): void {
  const seen = seenByProject.get()[projectId];
  if (seen?.issues[number] === updatedAt) {
    return;
  }
  if (seen) {
    setIssuesSeen(projectId, { ...seen, issues: { ...seen.issues, [number]: updatedAt } });
  }
  void window.tet.issues.markSeen(projectId, number, updatedAt);
}

/** The issue counts as unread again: kept as shown just before its `updatedAt`, so that `isUnread`
 *  holds until its tab shows it. */
export function keepIssueUnread(projectId: string, number: number, updatedAt: string): void {
  keepIssueSeen(projectId, number, new Date(Date.parse(updatedAt) - 1).toISOString());
}

/** Every issue of the project read, from now on; a notice when that cannot be kept. */
export async function keepAllIssuesSeen(projectId: string): Promise<void> {
  const result = await window.tet.issues.markAllSeen(projectId);
  if (result.ok) {
    setIssuesSeen(projectId, result.seen);
  } else {
    notify("error", result.error);
  }
}

/** Undefined until the project's list was read. */
export function useIssuesSeen(projectId: string): IssuesSeen | undefined {
  return useStore(seenByProject)[projectId];
}
