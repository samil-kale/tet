import { handle } from "./channels";
import { errorMessage, failure } from "../../shared/errors";
import type { ActionResult } from "../../shared/types/action";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type {
  ChangeRequestFilter,
  ChangeRequestLatestResult,
  ChangeRequestListResult,
  ChangeRequestReadResult,
  IssueChange,
  IssueFieldOptionsResult,
  IssueFieldValue,
  IssueFilterOptions,
  TrackedSeenResult,
} from "../../shared/types/providers";
import type { IssueSessionsResult } from "../../shared/types/terminals";
import {
  approveChangeRequest,
  changeRequestFieldOptions,
  changeRequestFilterOptions,
  changeRequestHost,
  changeRequestImage,
  changeRequestMarkdown,
  changeRequestSessions,
  commentChangeRequest,
  deleteChangeRequestComment,
  editChangeRequestComment,
  latestChangeRequests,
  listChangeRequests,
  mergeChangeRequest,
  readChangeRequest,
  sendChangeRequestToAgent,
  setChangeRequestField,
  updateChangeRequest,
} from "../change-requests/tracker";
import { NoAccountError } from "../providers/issues";
import { markAllSeen, readSeen, setSeen } from "../store/tracked-seen";
import { logFailure } from "../util/json-file";
import type { IpcDeps } from "./deps";

/** The change requests section and a change request's tab, as the Issues section's registrar: by
 *  project, each answering its failure for the caller to notify. */
export function registerChangeRequestsIpc({ issueDeps }: Pick<IpcDeps, "issueDeps">): void {
  const { dataRoot } = issueDeps;

  /** A write to the project's host, as an `ActionResult`. */
  const written = async (write: () => Promise<unknown>): Promise<ActionResult> => {
    try {
      await write();
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  };

  handle("change-requests:list", async (_event, projectId: string, filter: ChangeRequestFilter): Promise<ChangeRequestListResult> => {
    try {
      const { changeRequests, latest } = await listChangeRequests(issueDeps, projectId, filter);
      const { host, path, provider, kind } = await changeRequestHost(issueDeps, projectId);
      return {
        changeRequests,
        latest,
        kind,
        tracker: provider === undefined ? undefined : { provider, url: `https://${host}/${path}` },
        seen: readSeen(dataRoot, projectId, "change-request"),
      };
    } catch (error) {
      const kind = await changeRequestHost(issueDeps, projectId).then(
        (found) => found.kind,
        () => undefined,
      );
      return { kind, error: errorMessage(error), noAccount: error instanceof NoAccountError };
    }
  });

  handle("change-requests:latest", async (_event, projectId: string, filter: ChangeRequestFilter): Promise<ChangeRequestLatestResult> => {
    try {
      return { latest: await latestChangeRequests(issueDeps, projectId, filter) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("change-requests:filter-options", async (_event, projectId: string): Promise<IssueFilterOptions> => {
    try {
      return await changeRequestFilterOptions(issueDeps, projectId);
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("change-requests:read", async (_event, projectId: string, number: number): Promise<ChangeRequestReadResult> => {
    try {
      const changeRequest = await readChangeRequest(issueDeps, projectId, number);
      return { changeRequest, markdown: changeRequestMarkdown(changeRequest) };
    } catch (error) {
      // Names what was read and where: the notice may come up in another project's tab.
      const named = issueDeps.store.get(projectId)?.name;
      return { error: `${named ? `${named}: ` : ""}change request ${number}: ${errorMessage(error)}` };
    }
  });

  handle("change-requests:send-to-agent", (_event, ref: ProjectRef, number: number, agentId: AgentId) =>
    sendChangeRequestToAgent(issueDeps, ref, number, agentId),
  );

  handle("change-requests:sessions", (_event, projectId: string): IssueSessionsResult => {
    try {
      return { sessions: changeRequestSessions(issueDeps, projectId) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("change-requests:image", (_event, projectId: string, source: string): Promise<string | null> =>
    changeRequestImage(issueDeps, projectId, source),
  );

  handle(
    "change-requests:field-options",
    async (_event, projectId: string, number: number, fieldId: string): Promise<IssueFieldOptionsResult> => {
      try {
        return { options: await changeRequestFieldOptions(issueDeps, projectId, number, fieldId) };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    },
  );

  handle("change-requests:comment", (_event, projectId: string, number: number, body: string) =>
    written(() => commentChangeRequest(issueDeps, projectId, number, body)),
  );

  handle("change-requests:edit-comment", (_event, projectId: string, id: string, body: string) =>
    written(() => editChangeRequestComment(issueDeps, projectId, id, body)),
  );

  handle("change-requests:delete-comment", (_event, projectId: string, id: string) =>
    written(() => deleteChangeRequestComment(issueDeps, projectId, id)),
  );

  handle("change-requests:update", (_event, projectId: string, number: number, change: IssueChange) =>
    written(() => updateChangeRequest(issueDeps, projectId, number, change)),
  );

  handle("change-requests:set-field", (_event, projectId: string, number: number, fieldId: string, value: IssueFieldValue) =>
    written(() => setChangeRequestField(issueDeps, projectId, number, fieldId, value)),
  );

  handle("change-requests:approve", (_event, projectId: string, number: number) =>
    written(() => approveChangeRequest(issueDeps, projectId, number)),
  );

  handle("change-requests:merge", (_event, projectId: string, number: number, whenChecksPass: boolean) =>
    written(() => mergeChangeRequest(issueDeps, projectId, number, whenChecksPass)),
  );

  handle("change-requests:mark-seen", (_event, projectId: string, number: number, updatedAt: string, failed: boolean) => {
    logFailure("keep a change request's last seen update", () => setSeen(dataRoot, projectId, "change-request", number, updatedAt, failed));
  });

  handle("change-requests:mark-all-seen", (_event, projectId: string): TrackedSeenResult => {
    try {
      return { ok: true, seen: markAllSeen(dataRoot, projectId, "change-request") };
    } catch (error) {
      return failure(error);
    }
  });
}
