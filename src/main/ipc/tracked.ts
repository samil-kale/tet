import { handle } from "./channels";
import { attempt, errorMessage, failure } from "../../shared/errors";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type {
  IssueChange,
  IssueFieldOptionsResult,
  IssueFieldValue,
  TrackedKind,
  TrackedReadResult,
  TrackedRef,
  TrackedSeenResult,
} from "../../shared/types/providers";
import type { TrackedSessionsResult } from "../../shared/types/terminals";
import { markAllSeen, setSeen } from "../store/tracked-seen";
import { sendTrackedToAgent, trackedSessions } from "../tracked";
import { logFailure } from "../util/json-file";
import type { IpcDeps } from "./deps";

/** An issue's tab and a change request's alike, by kind (tracked.ts's `trackedOps`): by project, each
 *  answering its failure for the caller to notify. */
export function registerTrackedIpc({ issueDeps, tracked: ops }: Pick<IpcDeps, "issueDeps" | "tracked">): void {
  const { dataRoot } = issueDeps;

  handle("tracked:read", async (_event, projectId: string, { kind, number }: TrackedRef): Promise<TrackedReadResult> => {
    try {
      return await ops[kind].read(projectId, number);
    } catch (error) {
      // Names what was read and where: the notice may come up in another project's tab.
      const named = issueDeps.store.get(projectId)?.name;
      return { error: `${named ? `${named}: ` : ""}${ops[kind].nameOf(number)}: ${errorMessage(error)}` };
    }
  });

  handle("tracked:image", (_event, projectId: string, kind: TrackedKind, source: string): Promise<string | null> =>
    ops[kind].image(projectId, source),
  );

  handle("tracked:comment", (_event, projectId: string, { kind, number }: TrackedRef, body: string, internal: boolean) =>
    attempt(() => ops[kind].comment(projectId, number, body, internal)),
  );

  handle("tracked:edit-comment", (_event, projectId: string, kind: TrackedKind, id: string, body: string) =>
    attempt(() => ops[kind].editComment(projectId, id, body)),
  );

  handle("tracked:delete-comment", (_event, projectId: string, kind: TrackedKind, id: string) =>
    attempt(() => ops[kind].deleteComment(projectId, id)),
  );

  handle("tracked:update", (_event, projectId: string, { kind, number }: TrackedRef, change: IssueChange) =>
    attempt(() => ops[kind].update(projectId, number, change)),
  );

  handle(
    "tracked:field-options",
    async (_event, projectId: string, { kind, number }: TrackedRef, fieldId: string): Promise<IssueFieldOptionsResult> => {
      try {
        return { options: await ops[kind].fieldOptions(projectId, number, fieldId) };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    },
  );

  handle("tracked:set-field", (_event, projectId: string, { kind, number }: TrackedRef, fieldId: string, value: IssueFieldValue) =>
    attempt(() => ops[kind].setField(projectId, number, fieldId, value)),
  );

  handle("tracked:mark-seen", (_event, projectId: string, { kind, number }: TrackedRef, updatedAt: string, failed: boolean) => {
    logFailure(`keep a ${kind}'s last seen update`, () => setSeen(dataRoot, projectId, kind, number, updatedAt, failed));
  });

  handle("tracked:mark-all-seen", (_event, projectId: string, kind: TrackedKind): TrackedSeenResult => {
    try {
      return { ok: true, seen: markAllSeen(dataRoot, projectId, kind) };
    } catch (error) {
      return failure(error);
    }
  });

  handle("tracked:send-to-agent", (_event, ref: ProjectRef, tracked: TrackedRef, agentId: AgentId) =>
    sendTrackedToAgent(issueDeps, ops, ref, tracked, agentId),
  );

  handle("tracked:sessions", (_event, projectId: string, kind: TrackedKind): TrackedSessionsResult => {
    try {
      return { sessions: trackedSessions(issueDeps, projectId, kind) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });
}
