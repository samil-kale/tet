import type { Issue, IssueFilter, IssueListResult, TrackedLatest } from "../../../shared/types/providers";
import { subscribeTracked } from "../../editor/editor-tab";
import { reloadChangedTabs } from "../../editor/tracked/tracked-views";
import { setSeen } from "../../editor/tracked/tracked-seen";
import { subscribeAccounts } from "../../git/ProviderAccount";
import { useTrackedList, type TrackedList, type TrackedListSource } from "../../editor/tracked/use-tracked-list";

/** The Issues section's list, from the project's tracker: read again once tet.json, an account or an
 *  issue through its tab changes. */
const ISSUES: TrackedListSource<IssueFilter, Issue, TrackedLatest, IssueListResult> = {
  list: (projectId, filter, limit, after) => window.tet.issues.list(projectId, filter, limit, after),
  latest: (projectId, filter) => window.tet.issues.latest(projectId, filter),
  filterOptions: (projectId) => window.tet.issues.filterOptions(projectId),
  differ: (shown, found) => shown?.total !== found.total || shown.updatedAt !== found.updatedAt,
  seen: (projectId, seen) => setSeen("issue", projectId, seen),
  changed: (projectId, items) => reloadChangedTabs("issue", projectId, items),
  subscribe: (projectId, reread) => {
    const unsubscribers = [
      window.tet.commands.onChanged((changed) => {
        if (changed.projectId === projectId) {
          reread(false);
        }
      }),
      subscribeAccounts(() => reread(false)),
      subscribeTracked("issue", (changed) => {
        if (changed === projectId) {
          reread(true);
        }
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  },
};

/** The project's issues under `filter` whose titles hold `text` (`useTrackedList`). */
export function useIssues(projectId: string, filter: IssueFilter, text: string, shown: boolean): TrackedList<Issue, IssueListResult> {
  return useTrackedList(ISSUES, projectId, filter, text, shown);
}
