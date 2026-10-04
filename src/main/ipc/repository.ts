import type { IpcMainInvokeEvent } from "electron";
import { handle, on } from "./channels";
import { getAgent, listAskableAgents, listAskModels } from "../agents";
import { effectivePrompt } from "../../shared/prompts";
import { failure } from "../../shared/errors";
import type { AgentId, AskModelsResult, SuggestionResult } from "../../shared/types/agents";
import type { ExplorerListing, ExplorerSettings, FileContent, FileSearchQuery, FileSearchResult, FileWriteResult } from "../../shared/types/files";
import type { CheckoutTarget, GitActionResult, GitLogin, RepositoryState, StashCommand } from "../../shared/types/git";
import type { ProjectRef } from "../../shared/types/project";
import {
  addExclude,
  addFolder,
  DEFAULT_EXPLORER_VIEW,
  readExplorerView,
  removeFolder,
  setExplorerSetting
} from "../store/tet-json";
import { cancelCommitSuggestion, suggestCommitMessage } from "../agents/commit-message";
import { git } from "../git/git-client";
import type { Repository } from "../git/repository";
import { MISSING_REPOSITORY, type IpcDeps } from "./deps";

/** Everything the git lane and the editor ask of one repository. */
export function registerRepositoryIpc({
  settings,
  store,
  repositories
}: Pick<IpcDeps, "settings" | "store" | "repositories">): void {
  handle("repository:state", (_event, ref: ProjectRef): RepositoryState => {
    return repositories.get(ref)?.getState() ?? MISSING_REPOSITORY;
  });

  handle("repository:refresh", (_event, ref: ProjectRef): void => {
    repositories.get(ref)?.refreshSoon();
  });

  /** A repository command answering a GitActionResult, or an error when the repository or worktree
   *  is not open. */
  const inRepository =
    <A extends unknown[]>(run: (repository: Repository, ...args: A) => Promise<GitActionResult>) =>
    async (_event: IpcMainInvokeEvent, ref: ProjectRef, ...args: A): Promise<GitActionResult> => {
      const repository = repositories.get(ref);
      return repository ? run(repository, ...args) : { ok: false, error: MISSING_REPOSITORY.error };
    };

  /** A write to the project's tet.json, which only its repository has (tet-json.ts's configRoot),
   *  reached through the store as the commands are; the watcher sees the write and re-lists. */
  const inProjectFile =
    <A extends unknown[]>(write: (root: string, ...args: A) => Promise<void>) =>
    async (_event: IpcMainInvokeEvent, projectId: string, ...args: A): Promise<GitActionResult> => {
      const project = store.get(projectId);
      return project
        ? write(project.path, ...args).then(() => ({ ok: true }), failure)
        : { ok: false, error: MISSING_REPOSITORY.error };
    };

  handle("repository:checkout", inRepository((repository, target: CheckoutTarget) => repository.checkout(target)));
  handle("repository:fetch", inRepository((repository, login?: GitLogin) => repository.fetch(login)));
  handle("repository:pull", inRepository((repository, login?: GitLogin) => repository.pull(login)));
  handle("repository:push", inRepository((repository, login?: GitLogin) => repository.push(login)));
  handle("repository:set-remote-url", inRepository((repository, remote: string, url: string) =>
    repository.setRemoteUrl(remote, url))
  );
  handle("repository:create-branch", inRepository((repository, name: string, startPoint: string) =>
    repository.createBranch(name, startPoint))
  );
  handle("repository:rename-branch", inRepository((repository, from: string, to: string) => repository.renameBranch(from, to)));
  handle("repository:delete-branch", inRepository((repository, name: string, onRemote: boolean) =>
    repository.deleteBranch(name, onRemote))
  );
  handle("repository:delete-remote-branch", inRepository((repository, remote: string, name: string, login?: GitLogin) =>
    repository.deleteRemoteBranch(remote, name, login))
  );
  handle("repository:merge", inRepository((repository, ref: string) => repository.merge(ref)));
  handle("repository:rebase", inRepository((repository, ref: string, confirmed: boolean) => repository.rebase(ref, confirmed)));
  handle("repository:abort", inRepository((repository) => repository.abort()));
  handle("repository:create-tag", inRepository((repository, name: string, target: string, message: string) =>
    repository.createTag(name, target, message))
  );
  handle("repository:push-tag", inRepository((repository, name: string, login?: GitLogin) => repository.pushTag(name, login)));
  handle("repository:delete-tag", inRepository((repository, name: string, onRemote: boolean) =>
    repository.deleteTag(name, onRemote))
  );
  handle("repository:delete-remote-tag", inRepository((repository, name: string, login?: GitLogin) =>
    repository.deleteRemoteTag(name, login))
  );
  handle("repository:checkout-tag", inRepository((repository, name: string) => repository.checkoutTag(name)));
  handle("repository:commit-all", inRepository((repository, message: string) => repository.commitAll(message)));
  handle("repository:commit-paths", inRepository((repository, message: string, paths: string[]) =>
    repository.commitPaths(message, paths))
  );
  handle("repository:suggestion-agents", async (_event, ref: ProjectRef): Promise<AgentId[]> => {
    const repository = repositories.get(ref);
    return repository ? listAskableAgents(repository.at.path) : [];
  });
  handle("repository:suggestion-models", async (_event, ref: ProjectRef, agentId: AgentId): Promise<AskModelsResult> => {
    const repository = repositories.get(ref);
    return repository ? listAskModels(getAgent(agentId), repository.at.path) : { models: [] };
  });
  handle(
    "repository:suggest-commit-message",
    async (_event, ref: ProjectRef, paths?: string[]): Promise<SuggestionResult> => {
      const repository = repositories.get(ref);
      if (!repository) {
        return {};
      }
      const cwd = repository.at.path;
      // A pick not installed here gives way to the first agent that is, with its default model, as
      // the settings' picker shows it.
      const picked = settings.get().prompts.commitSuggester;
      const askable = await listAskableAgents(cwd);
      const suggester = askable.includes(picked.agentId) ? picked : { agentId: askable[0] ?? "", model: "" };
      const prompt = effectivePrompt(settings.get().prompts.texts, "commitMessage");
      // The commit's own paths, a rename's old one included.
      return suggestCommitMessage(suggester, cwd, prompt, () => git.readCommitContext(cwd, paths && repository.pathspec(paths)));
    }
  );
  on("repository:cancel-commit-suggestion", () => cancelCommitSuggestion());
  handle("repository:stash-push", inRepository((repository, message: string) => repository.stashPush(message)));
  handle("repository:stash", inRepository((repository, command: StashCommand, sha: string) => repository.stash(command, sha)));
  handle("repository:discard", inRepository(async (repository, paths: string[], permanently: boolean) =>
    paths.length > 0 ? repository.discard(paths, permanently) : { ok: true })
  );
  handle("repository:ignore", inRepository((repository, filePath: string, scope: "file" | "extension") =>
    repository.ignore(filePath, scope))
  );
  handle("repository:create-file", inRepository((repository, filePath: string) => repository.createFile(filePath)));
  handle("repository:create-directory", inRepository((repository, dirPath: string) => repository.createDirectory(dirPath)));
  handle("repository:delete-path", inRepository((repository, filePath: string) => repository.deletePath(filePath)));
  handle("repository:rename-path", inRepository((repository, fromPath: string, toPath: string) =>
    repository.renamePath(fromPath, toPath))
  );
  handle("repository:add-folder", inProjectFile((root, folderPath: string) => addFolder(root, folderPath)));
  handle("repository:remove-folder", inProjectFile((root, folderPath: string) => removeFolder(root, folderPath)));
  handle("repository:exclude-path", inProjectFile((root, relPath: string) => addExclude(root, relPath)));
  handle("repository:set-explorer-setting", inProjectFile((root, key: keyof ExplorerSettings, value: ExplorerSettings[keyof ExplorerSettings]) =>
      setExplorerSetting(root, key, value))
  );

  handle("repository:list-explorer", async (_event, ref: ProjectRef): Promise<ExplorerListing> => {
    return (
      (await repositories.get(ref)?.listExplorer()) ?? {
        files: [],
        emptyDirs: [],
        compactFolders: DEFAULT_EXPLORER_VIEW.compactFolders,
        sortOrder: DEFAULT_EXPLORER_VIEW.sortOrder
      }
    );
  });

  handle("repository:search-files", async (_event, ref: ProjectRef, query: FileSearchQuery): Promise<FileSearchResult> => {
    return (await repositories.get(ref)?.searchFiles(query)) ?? { files: [], truncated: false };
  });

  // The settings Files tab: tet.json's view settings only, no walk; folders and exclude globs stay
  // the tree's own.
  handle("repository:explorer-settings", async (_event, projectId: string): Promise<ExplorerSettings> => {
    const project = store.get(projectId);
    if (!project) {
      return DEFAULT_EXPLORER_VIEW;
    }
    const { excludeGitIgnore, compactFolders, sortOrder } = await readExplorerView(project.path);
    return { excludeGitIgnore, compactFolders, sortOrder };
  });

  handle("repository:watch-files", (_event, ref: ProjectRef, paths: string[]): void => {
    repositories.get(ref)?.watchFiles(paths);
  });

  handle("repository:read-file", async (_event, ref: ProjectRef, filePath: string): Promise<FileContent> => {
    const repository = repositories.get(ref);
    if (!repository) {
      return { path: filePath, content: "", mtimeMs: 0, binary: false, tooLarge: false, error: MISSING_REPOSITORY.error };
    }
    return repository.readFile(filePath);
  });

  handle(
    "repository:write-file",
    async (_event, ref: ProjectRef, filePath: string, content: string, expectedMtimeMs: number): Promise<FileWriteResult> => {
      const repository = repositories.get(ref);
      if (!repository) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      return repository.writeFile(filePath, content, expectedMtimeMs);
    }
  );
}
