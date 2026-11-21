import * as path from "node:path";
import { app, dialog } from "electron";
import { handle } from "./channels";
import { errorMessage, failure } from "../../shared/errors";
import type { ActionResult } from "../../shared/types/action";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type {
  IssueChange,
  IssueCreateResult,
  IssueFieldOptionsResult,
  IssueFieldValue,
  IssueFilter,
  IssueFilterOptions,
  IssueLatestResult,
  IssueListResult,
  IssueReadResult,
  TrackedSeenResult,
  IssueUploadResult,
  IssueUploadSaveResult,
} from "../../shared/types/providers";
import type { IssueSessionsResult } from "../../shared/types/terminals";
import {
  changeIssueSource,
  commentIssue,
  createIssue,
  deleteIssue,
  deleteIssueComment,
  editIssueComment,
  issueFieldOptions,
  issueFilterOptions,
  issueImage,
  issueRepository,
  issueSessions,
  issueUploadName,
  latestIssues,
  sendIssueToAgent,
  readIssue,
  saveIssueUpload,
  setIssueField,
  updateIssue,
  uploadIssueFile,
} from "../issues";
import { issueMarkdown, NoAccountError, onTracker, readIssueTracker } from "../providers/issues";
import { markAllSeen, readSeen, setSeen } from "../store/tracked-seen";
import { readIssueSource } from "../store/tet-json";
import { logFailure } from "../util/json-file";
import type { IpcDeps } from "./deps";

/** The Issues section: read from the project's tracker, by project, since the repository and its
 *  worktrees share one. Each answers its failure for the section to notify; `setSource` for the
 *  question still up to show it at its field. */
export function registerIssuesIpc({ issueDeps, noticeProgress }: Pick<IpcDeps, "issueDeps" | "noticeProgress">): void {
  const { accounts, dataRoot } = issueDeps;

  /** A write to the project's tracker, as an `ActionResult`. */
  const written = async (write: () => Promise<unknown>): Promise<ActionResult> => {
    try {
      await write();
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  };

  handle("issues:list", async (_event, projectId: string, filter: IssueFilter, limit: number): Promise<IssueListResult> => {
    let source: string | undefined;
    try {
      const repository = issueRepository(issueDeps, projectId);
      source = await readIssueSource(repository.at.path);
      const { issues, latest, confidentialIssues } = await onTracker(accounts, repository, async (provider, tracker) => ({
        // First: a change made while the list comes then differs from it at the next read.
        latest: await provider.readLatest(tracker, filter),
        issues: await provider.listIssues(tracker, filter, limit),
        confidentialIssues: provider.confidentialIssues,
      }));
      const { provider, host, path } = await readIssueTracker(accounts, repository);
      return {
        issues,
        latest,
        source,
        tracker: provider === null ? undefined : { provider, url: `https://${host}/${path}`, confidentialIssues },
        seen: readSeen(dataRoot, projectId, "issue"),
      };
    } catch (error) {
      return { source, error: errorMessage(error), noAccount: error instanceof NoAccountError };
    }
  });

  handle("issues:latest", async (_event, projectId: string, filter: IssueFilter): Promise<IssueLatestResult> => {
    try {
      return { latest: await latestIssues(issueDeps, projectId, filter) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:filter-options", async (_event, projectId: string): Promise<IssueFilterOptions> => {
    try {
      return await issueFilterOptions(issueDeps, projectId);
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:read", async (_event, projectId: string, number: number): Promise<IssueReadResult> => {
    try {
      const issue = await readIssue(issueDeps, projectId, number);
      return { issue, markdown: issueMarkdown(issue) };
    } catch (error) {
      // Names what was read and where: the notice may come up in another project's tab.
      const named = issueDeps.store.get(projectId)?.name;
      return { error: `${named ? `${named}: ` : ""}issue #${number}: ${errorMessage(error)}` };
    }
  });

  handle("issues:send-to-agent", (_event, ref: ProjectRef, number: number, agentId: AgentId) =>
    sendIssueToAgent(issueDeps, ref, number, agentId),
  );

  handle("issues:sessions", (_event, projectId: string): IssueSessionsResult => {
    try {
      return { sessions: issueSessions(issueDeps, projectId) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:image", (_event, projectId: string, source: string): Promise<string | null> => issueImage(issueDeps, projectId, source));

  handle("issues:field-options", async (_event, projectId: string, number: number, fieldId: string): Promise<IssueFieldOptionsResult> => {
    try {
      return { options: await issueFieldOptions(issueDeps, projectId, number, fieldId) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle(
    "issues:create",
    async (_event, projectId: string, title: string, body: string, confidential: boolean): Promise<IssueCreateResult> => {
      try {
        return { ok: true, number: await createIssue(issueDeps, projectId, title, body, confidential) };
      } catch (error) {
        return failure(error);
      }
    },
  );

  handle("issues:comment", (_event, projectId: string, number: number, body: string, internal: boolean) =>
    written(() => commentIssue(issueDeps, projectId, number, body, internal)),
  );

  handle("issues:edit-comment", (_event, projectId: string, id: string, body: string) =>
    written(() => editIssueComment(issueDeps, projectId, id, body)),
  );

  handle("issues:delete-comment", (_event, projectId: string, id: string) => written(() => deleteIssueComment(issueDeps, projectId, id)));

  handle("issues:update", (_event, projectId: string, number: number, change: IssueChange) =>
    written(() => updateIssue(issueDeps, projectId, number, change)),
  );

  handle("issues:set-field", (_event, projectId: string, number: number, fieldId: string, value: IssueFieldValue) =>
    written(() => setIssueField(issueDeps, projectId, number, fieldId, value)),
  );

  handle("issues:delete", (_event, projectId: string, number: number) => written(() => deleteIssue(issueDeps, projectId, number)));

  handle("issues:mark-seen", (_event, projectId: string, number: number, updatedAt: string) => {
    logFailure("keep an issue's last seen update", () => setSeen(dataRoot, projectId, "issue", number, updatedAt));
  });

  handle("issues:mark-all-seen", (_event, projectId: string): TrackedSeenResult => {
    try {
      return { ok: true, seen: markAllSeen(dataRoot, projectId, "issue") };
    } catch (error) {
      return failure(error);
    }
  });

  handle("issues:upload", async (_event, projectId: string, name: string, dataBase64: string): Promise<IssueUploadResult> => {
    try {
      return { markdown: await uploadIssueFile(issueDeps, projectId, name, Buffer.from(dataBase64, "base64")) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  /** Asks where to save the upload, then downloads it under a progress notice of its own. */
  handle("issues:save-upload", async (_event, projectId: string, source: string): Promise<IssueUploadSaveResult> => {
    const name = await issueUploadName(issueDeps, projectId, source).catch(() => undefined);
    if (name === undefined) {
      return { upload: false };
    }
    const picked = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath("downloads"), name) });
    if (picked.canceled || !picked.filePath) {
      return { upload: true };
    }
    const target = picked.filePath;
    const key = `issue-upload:${target}`;
    const message = `Downloading ${name}`;
    noticeProgress({ key, message, fraction: null });
    try {
      await saveIssueUpload(issueDeps, projectId, source, target, (fraction) => noticeProgress({ key, message, fraction }));
      noticeProgress({ key, message: `Saved ${path.basename(target)}`, fraction: undefined, done: true });
      return { upload: true };
    } catch (error) {
      noticeProgress({ key, message, fraction: undefined });
      return { upload: true, error: `Could not save ${name}: ${errorMessage(error)}` };
    }
  });

  handle("issues:set-source", async (_event, projectId: string, source: string): Promise<ActionResult> => {
    try {
      await changeIssueSource(issueDeps, projectId, source);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });
}
