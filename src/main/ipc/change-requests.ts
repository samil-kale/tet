import { handle } from "./channels";
import { attempt, errorMessage } from "../../shared/errors";
import type {
  ChangeRequestFilter,
  ChangeRequestLatestResult,
  ChangeRequestListResult,
  TrackedFilterOptions,
} from "../../shared/types/providers";
import { NoAccountError } from "../providers/tracker";
import { readSeen } from "../store/tracked-seen";
import type { IpcDeps } from "./deps";

/** The change requests section, as the Issues section's registrar: by project, each answering its
 *  failure for the caller to notify. What a change request's tab does as an issue's does is
 *  tracked.ts's. */
export function registerChangeRequestsIpc({ changeRequests, trackedDeps }: Pick<IpcDeps, "changeRequests" | "trackedDeps">): void {
  const { dataRoot } = trackedDeps;

  handle(
    "change-requests:list",
    async (_event, projectId: string, filter: ChangeRequestFilter, limit: number, after?: string): Promise<ChangeRequestListResult> => {
      const kind = changeRequests.kind(projectId).catch(() => undefined);
      try {
        const { items, after: next, latest } = await changeRequests.page(projectId, filter, limit, after);
        return {
          items,
          after: next,
          latest,
          kind: await kind,
          ...(after === undefined && { seen: readSeen(dataRoot, projectId, "change-request") }),
        };
      } catch (error) {
        return { kind: await kind, error: errorMessage(error), noAccount: error instanceof NoAccountError };
      }
    },
  );

  handle("change-requests:latest", async (_event, projectId: string, filter: ChangeRequestFilter): Promise<ChangeRequestLatestResult> => {
    try {
      return { latest: await changeRequests.latest(projectId, filter) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("change-requests:filter-options", async (_event, projectId: string): Promise<TrackedFilterOptions> => {
    try {
      return await changeRequests.filterOptions(projectId);
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("change-requests:approve", (_event, projectId: string, number: number) =>
    attempt(() => changeRequests.approve(projectId, number)),
  );

  handle("change-requests:merge", (_event, projectId: string, number: number, whenChecksPass: boolean) =>
    attempt(() => changeRequests.merge(projectId, number, whenChecksPass)),
  );
}
