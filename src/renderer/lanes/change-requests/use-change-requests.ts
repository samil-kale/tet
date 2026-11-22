import type { ChangeRequestFilter, ChangeRequestListResult, ChangeRequestRow, ChangeRequestsLatest } from "../../../shared/types/providers";
import { subscribeTracked } from "../../editor/editor-tab";
import { reloadChangedTabs } from "../../editor/editor-views";
import { setSeen } from "../../editor/tracked-seen";
import { subscribeAccounts } from "../../git/ProviderAccount";
import { useTrackedList, type TrackedList, type TrackedListSource } from "../../ui/use-tracked-list";

/** The change requests section's list, from the repository's own remote: read again once an account
 *  or a change request through its tab changes, or the host says the list or its checks changed (a
 *  check that ends changes no `updatedAt`). */
const CHANGE_REQUESTS: TrackedListSource<ChangeRequestFilter, ChangeRequestRow, ChangeRequestsLatest, ChangeRequestListResult> = {
  list: (projectId, filter, limit, after) => window.tet.changeRequests.list(projectId, filter, limit, after),
  latest: (projectId, filter) => window.tet.changeRequests.latest(projectId, filter),
  filterOptions: (projectId) => window.tet.changeRequests.filterOptions(projectId),
  differ: (shown, found) => shown?.total !== found.total || shown.updatedAt !== found.updatedAt || shown.checks !== found.checks,
  seen: (projectId, seen) => setSeen("change-request", projectId, seen),
  changed: (projectId, items) => reloadChangedTabs("change-request", projectId, items),
  subscribe: (projectId, reread) => {
    const unsubscribers = [
      subscribeAccounts(() => reread(false)),
      subscribeTracked("change-request", (changed) => {
        if (changed === projectId) {
          reread(true);
        }
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  },
};

/** The project's change requests under `filter` whose titles hold `text` (`useTrackedList`). */
export function useChangeRequests(
  projectId: string,
  filter: ChangeRequestFilter,
  text: string,
  shown: boolean,
): TrackedList<ChangeRequestRow, ChangeRequestListResult> {
  return useTrackedList(CHANGE_REQUESTS, projectId, filter, text, shown);
}
