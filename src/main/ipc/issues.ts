import { handle } from "./channels";
import { errorMessage, failure } from "../../shared/errors";
import { effectivePrompt } from "../../shared/prompts";
import type { ActionResult } from "../../shared/types/action";
import type { AgentId } from "../../shared/types/agents";
import type { ProjectRef } from "../../shared/types/project";
import type { HandoverResult } from "../../shared/types/terminals";
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
import { issueMarkdown, NoAccountError, onTracker, setIssueSource, writeOnTracker, type TrackerCall } from "../providers/issues";
import { forgetAllIssuesSeen, forgetIssueSeen, markAllIssuesSeen, readIssuesSeen, setIssueSeen } from "../store/issues-seen";
import { notOpenMessage, PROJECT_NOT_FOUND } from "../store/resolved-ref";
import { readIssueSource } from "../store/tet-json";
import { imageDataUrl } from "../util/image-response";
import { logFailure } from "../util/json-file";
import type { IpcDeps } from "./deps";

/** More than either tracker takes of one file: past this it does not cross to main's memory. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** The first prompt of a tab opened on an issue: the settings' text, then which issue it is, ended
 *  by its file's path. */
function issuePrompt(text: string, number: number): string {
  return `${text}\n\nThe issue: #${number}. The file:`;
}

/** The ISSUES section: read from the project's tracker, by project, since the repository and its
 *  worktrees share one. Each answers its failure for the section to notify; `setSource` for the
 *  question still up to show it at its field. */
export function registerIssuesIpc({
  accounts,
  projectDeps,
  repositories,
  settings,
  store,
  tabManagers,
}: Pick<IpcDeps, "accounts" | "projectDeps" | "repositories" | "settings" | "store" | "tabManagers">): void {
  const { dataRoot } = projectDeps;

  const repositoryOf = (projectId: string) => {
    const repository = repositories.get({ projectId });
    if (!repository) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    return repository;
  };

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
      return { issues, latest, source, seen: readIssuesSeen(dataRoot, projectId) };
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

  handle("issues:open-in-agent", async (_event, ref: ProjectRef, number: number, agentId: AgentId): Promise<HandoverResult> => {
    try {
      const manager = tabManagers.get(ref);
      if (!manager) {
        throw new Error(notOpenMessage(store, ref));
      }
      const issue = await onTracker(accounts, repositoryOf(ref.projectId), (provider, tracker) => provider.readIssue(tracker, number));
      const file = { name: `issue-${number}.md`, content: issueMarkdown(issue), prompt: issuePrompt(effectivePrompt(settings.get().prompts.texts, "issue"), number) };
      return { ok: true, tab: manager.createTabOnFile(agentId, file) };
    } catch (error) {
      return failure(error);
    }
  });

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
      const repository = repositoryOf(projectId);
      const before = await readIssueSource(repository.at.path);
      if ((await setIssueSource(accounts, repository, source)) !== before) {
        forgetAllIssuesSeen(dataRoot, projectId);
      }
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });
}
