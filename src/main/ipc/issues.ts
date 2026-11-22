import * as path from "node:path";
import { app, dialog } from "electron";
import { handle } from "./channels";
import { attempt, errorMessage, failure } from "../../shared/errors";
import type { ActionResult } from "../../shared/types/action";
import type {
  IssueCreateResult,
  IssueFilter,
  IssueFilterOptions,
  IssueLatestResult,
  IssueListResult,
  IssueUploadResult,
  IssueUploadSaveResult,
} from "../../shared/types/providers";
import {
  changeIssueSource,
  createIssue,
  deleteIssue,
  issueFilterOptions,
  issueRepository,
  issueUploadName,
  latestIssues,
  saveIssueUpload,
  uploadIssueFile,
} from "../issues";
import { NoAccountError, onTracker, readIssueTracker } from "../providers/issues";
import { readSeen } from "../store/tracked-seen";
import { readIssueSource } from "../store/tet-json";
import type { IpcDeps } from "./deps";

/** The Issues section: read from the project's tracker, by project, since the repository and its
 *  worktrees share one. Each answers its failure for the section to notify; `setSource` for the
 *  question still up to show it at its field. What an issue's tab does as a change request's does is
 *  tracked.ts's. */
export function registerIssuesIpc({ issueDeps, noticeProgress }: Pick<IpcDeps, "issueDeps" | "noticeProgress">): void {
  const { accounts, dataRoot } = issueDeps;

  handle("issues:list", async (_event, projectId: string, filter: IssueFilter, limit: number, after?: string): Promise<IssueListResult> => {
    let source: string | undefined;
    try {
      const repository = issueRepository(issueDeps, projectId);
      if (after !== undefined) {
        return await onTracker(accounts, repository, (provider, tracker) => provider.listIssues(tracker, filter, limit, after));
      }
      source = await readIssueSource(repository.at.path);
      const { page, latest, confidentialIssues } = await onTracker(accounts, repository, async (provider, tracker) => ({
        // First: a change made while the list comes then differs from it at the next read.
        latest: await provider.readLatest(tracker, filter),
        page: await provider.listIssues(tracker, filter, limit),
        confidentialIssues: provider.confidentialIssues,
      }));
      const { provider, host, path } = await readIssueTracker(accounts, repository);
      return {
        ...page,
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

  handle("issues:delete", (_event, projectId: string, number: number) => attempt(() => deleteIssue(issueDeps, projectId, number)));

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

  handle("issues:set-source", (_event, projectId: string, source: string): Promise<ActionResult> =>
    attempt(() => changeIssueSource(issueDeps, projectId, source)),
  );
}
