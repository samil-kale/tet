import * as path from "node:path";
import { app, dialog } from "electron";
import { handle } from "./channels";
import { attempt, errorMessage, failure } from "../../shared/errors";
import type { ActionResult } from "../../shared/types/action";
import type {
  IssueCreateResult,
  IssueFilter,
  TrackedFilterOptions,
  IssueLatestResult,
  IssueListResult,
  IssueUploadResult,
  IssueUploadSaveResult,
} from "../../shared/types/providers";
import { NoAccountError } from "../providers/tracker";
import { readSeen } from "../store/tracked-seen";
import type { IpcDeps } from "./deps";

/** The Issues section: read from the project's tracker, by project, since the repository and its
 *  worktrees share one. Each answers its failure for the section to notify; `setSource` for the
 *  question still up to show it at its field. What an issue's tab does as a change request's does is
 *  tracked.ts's. */
export function registerIssuesIpc({
  issues,
  trackedDeps,
  noticeProgress,
}: Pick<IpcDeps, "issues" | "trackedDeps" | "noticeProgress">): void {
  const { dataRoot } = trackedDeps;

  handle("issues:list", async (_event, projectId: string, filter: IssueFilter, limit: number, after?: string): Promise<IssueListResult> => {
    let source: string | undefined;
    try {
      if (after !== undefined) {
        return await issues.page(projectId, filter, limit, after);
      }
      source = await issues.source(projectId);
      return { ...(await issues.page(projectId, filter, limit)), source, seen: readSeen(dataRoot, projectId, "issue") };
    } catch (error) {
      return { source, error: errorMessage(error), noAccount: error instanceof NoAccountError };
    }
  });

  handle("issues:latest", async (_event, projectId: string, filter: IssueFilter): Promise<IssueLatestResult> => {
    try {
      return { latest: await issues.latest(projectId, filter) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:filter-options", async (_event, projectId: string): Promise<TrackedFilterOptions> => {
    try {
      return await issues.filterOptions(projectId);
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle(
    "issues:create",
    async (_event, projectId: string, title: string, body: string, confidential: boolean): Promise<IssueCreateResult> => {
      try {
        return { ok: true, number: await issues.create(projectId, title, body, confidential) };
      } catch (error) {
        return failure(error);
      }
    },
  );

  handle("issues:delete", (_event, projectId: string, number: number) => attempt(() => issues.delete(projectId, number)));

  handle("issues:upload", async (_event, projectId: string, name: string, dataBase64: string): Promise<IssueUploadResult> => {
    try {
      return { markdown: await issues.upload(projectId, name, Buffer.from(dataBase64, "base64")) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  /** Asks where to save the upload, then downloads it under a progress notice of its own. */
  handle("issues:save-upload", async (_event, projectId: string, source: string): Promise<IssueUploadSaveResult> => {
    const name = await issues.uploadName(projectId, source).catch(() => undefined);
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
      await issues.saveUpload(projectId, source, target, (fraction) => noticeProgress({ key, message, fraction }));
      noticeProgress({ key, message: `Saved ${path.basename(target)}`, fraction: undefined, done: true });
      return { upload: true };
    } catch (error) {
      noticeProgress({ key, message, fraction: undefined });
      return { upload: true, error: `Could not save ${name}: ${errorMessage(error)}` };
    }
  });

  handle("issues:set-source", (_event, projectId: string, source: string): Promise<ActionResult> =>
    attempt(() => issues.setSource(projectId, source)),
  );
}
