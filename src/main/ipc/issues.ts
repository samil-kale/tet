import { handle } from "./channels";
import { errorMessage } from "../../shared/errors";
import type { ActionResult } from "../../shared/types/action";
import type {
  IssueChange,
  IssueCreateResult,
  IssueFilter,
  IssueFilterOptions,
  IssueListResult,
  IssueMilestone,
  IssueReadResult,
  IssueUploadResult,
} from "../../shared/types/providers";
import { MAX_EDIT_BYTES } from "../git/explorer-read";
import { issueMarkdown, onTracker, setIssueSource, writeOnTracker } from "../providers/issues";
import { PROJECT_NOT_FOUND } from "../store/resolved-ref";
import { readIssueSource } from "../store/tet-json";
import { imageDataUrl } from "../util/image-response";
import type { IpcDeps } from "./deps";

/** More than either tracker takes of one file: past this it does not cross to main's memory. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** The ISSUES section: read from the project's tracker, by project, since the repository and its
 *  worktrees share one. Each answers its failure for the section to notify; `setSource` for the
 *  question still up to show it at its field. */
export function registerIssuesIpc({ accounts, repositories }: Pick<IpcDeps, "accounts" | "repositories">): void {
  const repositoryOf = (projectId: string) => {
    const repository = repositories.get({ projectId });
    if (!repository) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    return repository;
  };

  handle("issues:list", async (_event, projectId: string, filter: IssueFilter): Promise<IssueListResult> => {
    let source: string | undefined;
    try {
      const repository = repositoryOf(projectId);
      source = await readIssueSource(repository.at.path);
      const issues = await onTracker(accounts, repository, (provider, host, token, path) => provider.listIssues(host, token, path, filter));
      return { issues, source };
    } catch (error) {
      return { source, error: errorMessage(error) };
    }
  });

  handle("issues:filter-options", async (_event, projectId: string): Promise<IssueFilterOptions> => {
    try {
      return await onTracker(accounts, repositoryOf(projectId), async (provider, host, token, path) => {
        const [labels, people] = await Promise.all([provider.listLabels(host, token, path), provider.listPeople(host, token, path)]);
        return { labels, people };
      });
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:read", async (_event, projectId: string, number: number): Promise<IssueReadResult> => {
    try {
      const issue = await onTracker(accounts, repositoryOf(projectId), async (provider, host, token, path, viewer) => ({
        ...(await provider.readIssue(host, token, path, number)),
        viewer,
        uploads: provider.uploads(host),
      }));
      return { issue, markdown: issueMarkdown(issue) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  // Null when it takes no token or cannot be read: the text stands without it, as a preview's does.
  handle("issues:image", async (_event, projectId: string, source: string): Promise<string | null> => {
    try {
      const response = await onTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.readImage(host, token, path, source),
      );
      return response ? await imageDataUrl(response, MAX_EDIT_BYTES) : null;
    } catch {
      return null;
    }
  });

  handle("issues:milestones", async (_event, projectId: string): Promise<IssueMilestone[] | string> => {
    try {
      return await onTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.listMilestones(host, token, path),
      );
    } catch (error) {
      return errorMessage(error);
    }
  });

  handle("issues:create", async (_event, projectId: string, title: string, body: string): Promise<IssueCreateResult> => {
    try {
      const number = await writeOnTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.createIssue(host, token, path, title, body),
      );
      return { ok: true, number };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle("issues:edit-comment", async (_event, projectId: string, number: number, id: number, body: string): Promise<ActionResult> => {
    try {
      await writeOnTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.editComment(host, token, path, number, id, body),
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle("issues:delete-comment", async (_event, projectId: string, number: number, id: number): Promise<ActionResult> => {
    try {
      await writeOnTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.deleteComment(host, token, path, number, id),
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle("issues:delete", async (_event, projectId: string, number: number): Promise<ActionResult> => {
    try {
      await writeOnTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.deleteIssue(host, token, path, number),
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle("issues:upload", async (_event, projectId: string, name: string, dataBase64: string): Promise<IssueUploadResult> => {
    try {
      const bytes = Buffer.from(dataBase64, "base64");
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return { error: `${name} is too large to upload` };
      }
      const markdown = await writeOnTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.uploadFile ? provider.uploadFile(host, token, path, name, bytes) : Promise.reject(new Error(`${host} takes no upload`)),
      );
      return { markdown };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  handle("issues:comment", async (_event, projectId: string, number: number, body: string): Promise<ActionResult> => {
    try {
      await writeOnTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.addComment(host, token, path, number, body),
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle("issues:update", async (_event, projectId: string, number: number, change: IssueChange): Promise<ActionResult> => {
    try {
      await writeOnTracker(accounts, repositoryOf(projectId), (provider, host, token, path) =>
        provider.updateIssue(host, token, path, number, change),
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle("issues:set-source", async (_event, projectId: string, source: string): Promise<ActionResult> => {
    try {
      await setIssueSource(accounts, repositoryOf(projectId), source);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}
