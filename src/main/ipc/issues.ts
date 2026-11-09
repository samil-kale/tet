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
  IssuesSeenResult,
  IssueUploadResult,
} from "../../shared/types/providers";
import { MAX_EDIT_BYTES } from "../git/explorer-read";
import { changeIssueSource, issueRepository, openIssueInAgent } from "../issues";
import { issueMarkdown, NoAccountError, onTracker, readIssueTracker, writeOnTracker, type TrackerCall } from "../providers/issues";
import { forgetIssueSeen, markAllIssuesSeen, readIssuesSeen, setIssueSeen } from "../store/issues-seen";
import { readIssueSource } from "../store/tet-json";
import { imageDataUrl } from "../util/image-response";
import { logFailure } from "../util/json-file";
import type { IpcDeps } from "./deps";

/** More than either tracker takes of one file: past this it does not cross to main's memory. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** The ISSUES section: read from the project's tracker, by project, since the repository and its
 *  worktrees share one. Each answers its failure for the section to notify; `setSource` for the
 *  question still up to show it at its field. */
export function registerIssuesIpc({ issueDeps }: Pick<IpcDeps, "issueDeps">): void {
  const { accounts, dataRoot } = issueDeps;

  const repositoryOf = (projectId: string) => issueRepository(issueDeps, projectId);

  /** A write to the project's tracker (`writeOnTracker`), as an `ActionResult`. */
  const written = async (projectId: string, call: TrackerCall<unknown>): Promise<ActionResult> => {
    try {
      await writeOnTracker(accounts, repositoryOf(projectId), call);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  };

  handle("issues:list", async (_event, projectId: string, filter: IssueFilter): Promise<IssueListResult> => {
    let source: string | undefined;
    try {
      const repository = repositoryOf(projectId);
      source = await readIssueSource(repository.at.path);
      const { issues, latest } = await onTracker(accounts, repository, async (provider, tracker) => ({
        // First: a change made while the list comes then differs from it at the next read.
        latest: await provider.readLatest(tracker, filter),
        issues: await provider.listIssues(tracker, filter),
      }));
      const { provider, host, path } = await readIssueTracker(accounts, repository);
      return {
        issues,
        latest,
        source,
        tracker: provider === null ? undefined : { provider, url: `https://${host}/${path}` },
        seen: readIssuesSeen(dataRoot, projectId),
      };
    } catch (error) {
      return { source, error: errorMessage(error), noAccount: error instanceof NoAccountError };
    }
  });

  handle("issues:latest", async (_event, projectId: string, filter: IssueFilter): Promise<IssueLatestResult> => {
    try {
      const latest = await onTracker(accounts, repositoryOf(projectId), (provider, tracker) => provider.readLatest(tracker, filter));
      return { latest };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:filter-options", async (_event, projectId: string): Promise<IssueFilterOptions> => {
    try {
      return await onTracker(accounts, repositoryOf(projectId), async (provider, tracker) => {
        const [labels, people] = await Promise.all([provider.listLabels(tracker), provider.listPeople(tracker)]);
        return { labels, people };
      });
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:read", async (_event, projectId: string, number: number): Promise<IssueReadResult> => {
    try {
      const issue = await onTracker(accounts, repositoryOf(projectId), async (provider, tracker, viewer) => ({
        ...(await provider.readIssue(tracker, number)),
        viewer,
        uploads: provider.uploads(tracker.host),
        internalNotes: provider.internalNotes,
      }));
      return { issue, markdown: issueMarkdown(issue) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:open-in-agent", (_event, ref: ProjectRef, number: number, agentId: AgentId) =>
    openIssueInAgent(issueDeps, ref, number, agentId),
  );

  // Null when it takes no token or cannot be read: the text stands without it, as a preview's does.
  handle("issues:image", async (_event, projectId: string, source: string): Promise<string | null> => {
    try {
      const response = await onTracker(accounts, repositoryOf(projectId), (provider, tracker) => provider.readImage(tracker, source));
      return response ? await imageDataUrl(response, MAX_EDIT_BYTES) : null;
    } catch {
      return null;
    }
  });

  handle("issues:field-options", async (_event, projectId: string, number: number, fieldId: string): Promise<IssueFieldOptionsResult> => {
    try {
      const options = await onTracker(accounts, repositoryOf(projectId), (provider, tracker) =>
        provider.listOptions(tracker, number, fieldId),
      );
      return { options };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:create", async (_event, projectId: string, title: string, body: string): Promise<IssueCreateResult> => {
    try {
      const number = await writeOnTracker(accounts, repositoryOf(projectId), (provider, tracker) =>
        provider.createIssue(tracker, title, body),
      );
      return { ok: true, number };
    } catch (error) {
      return failure(error);
    }
  });

  handle("issues:comment", (_event, projectId: string, number: number, body: string, internal: boolean) =>
    written(projectId, (provider, tracker) => provider.addComment(tracker, number, body, internal)),
  );

  handle("issues:edit-comment", (_event, projectId: string, id: string, body: string) =>
    written(projectId, (provider, tracker) => provider.editComment(tracker, id, body)),
  );

  handle("issues:delete-comment", (_event, projectId: string, id: string) =>
    written(projectId, (provider, tracker) => provider.deleteComment(tracker, id)),
  );

  handle("issues:update", (_event, projectId: string, number: number, change: IssueChange) =>
    written(projectId, (provider, tracker) => provider.updateIssue(tracker, number, change)),
  );

  handle("issues:set-field", (_event, projectId: string, number: number, fieldId: string, value: IssueFieldValue) =>
    written(projectId, (provider, tracker) => provider.setField(tracker, number, fieldId, value)),
  );

  handle("issues:delete", async (_event, projectId: string, number: number) => {
    const result = await written(projectId, (provider, tracker) => provider.deleteIssue(tracker, number));
    if (result.ok) {
      forgetIssueSeen(dataRoot, projectId, number);
    }
    return result;
  });

  handle("issues:mark-seen", (_event, projectId: string, number: number, updatedAt: string) => {
    logFailure("keep an issue's last seen update", () => setIssueSeen(dataRoot, projectId, number, updatedAt));
  });

  handle("issues:mark-all-seen", (_event, projectId: string): IssuesSeenResult => {
    try {
      return { ok: true, seen: markAllIssuesSeen(dataRoot, projectId) };
    } catch (error) {
      return failure(error);
    }
  });

  handle("issues:upload", async (_event, projectId: string, name: string, dataBase64: string): Promise<IssueUploadResult> => {
    try {
      const bytes = Buffer.from(dataBase64, "base64");
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return { error: `${name} is too large to upload` };
      }
      const markdown = await writeOnTracker(accounts, repositoryOf(projectId), (provider, tracker) =>
        provider.uploads(tracker.host)
          ? provider.uploadFile(tracker, name, bytes)
          : Promise.reject(new Error(`${tracker.host} takes no upload`)),
      );
      return { markdown };
    } catch (error) {
      return { error: errorMessage(error) };
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
