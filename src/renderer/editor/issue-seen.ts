import type { IssuesSeen } from "../../shared/types/providers";
import { createStore, useStore } from "../ui/store";

const NONE: IssuesSeen = {};

/** What the tabs last showed of each project's issues: what the file held when the list was read,
 *  since then what `keepIssueSeen` kept. */
const seenByProject = createStore<Record<string, IssuesSeen>>({});

/** The project's list came with what the file holds. */
export function setIssuesSeen(projectId: string, seen: IssuesSeen): void {
  seenByProject.set({ ...seenByProject.get(), [projectId]: seen });
}

/** An issue's tab shows it as last changed at `updatedAt`: kept, and the ISSUES section stops marking
 *  it. What is already kept is not sent again. */
export function keepIssueSeen(projectId: string, number: number, updatedAt: string): void {
  const seen = seenByProject.get()[projectId] ?? NONE;
  if (seen[number] !== updatedAt) {
    setIssuesSeen(projectId, { ...seen, [number]: updatedAt });
    void window.tet.issues.markSeen(projectId, number, updatedAt);
  }
}

export function useIssuesSeen(projectId: string): IssuesSeen {
  return useStore(seenByProject)[projectId] ?? NONE;
}
