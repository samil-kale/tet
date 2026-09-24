import { ipcMain } from "electron";
import { AGENTS, findAskableAgent } from "../agents";
import { effectivePrompt } from "../../shared/prompts";
import { errorMessage } from "../../shared/errors";
import type {
  CheckoutTarget,
  ExplorerListing,
  ExplorerSettings,
  FileContent,
  FileSearchQuery,
  FileSearchResult,
  FileWriteResult,
  GitActionResult,
  GitLogin,
  RepositoryState,
  StashCommand,
  SuggestionResult
} from "../../shared/types";
import { DEFAULT_EXPLORER_VIEW } from "../tet-json";
import { suggestCommitMessage } from "../git/commit-message";
import { git } from "../git/git-client";
import type { Repository } from "../git/repository";
import { MISSING_REPOSITORY, type IpcDeps } from "./deps";

/** Everything the git pane and the editor ask of one repository. */
export function registerRepositoryIpc({
  store,
  settings,
  repositories
}: Pick<IpcDeps, "store" | "settings" | "repositories">): void {
  ipcMain.handle("repo:state", (_event, projectId: string): RepositoryState => {
    return repositories.get(projectId)?.getState() ?? MISSING_REPOSITORY;
  });

  ipcMain.handle("repo:refresh", async (_event, projectId: string): Promise<RepositoryState> => {
    return (await repositories.get(projectId)?.refresh()) ?? MISSING_REPOSITORY;
  });

  /** A repository command answering a GitActionResult, or an error when the project is not open. */
  const onRepository = <A extends unknown[]>(
    channel: string,
    run: (repository: Repository, ...args: A) => Promise<GitActionResult>
  ): void => {
    ipcMain.handle(channel, async (_event, projectId: string, ...args: A): Promise<GitActionResult> => {
      const repository = repositories.get(projectId);
      return repository ? run(repository, ...args) : { ok: false, error: MISSING_REPOSITORY.error };
    });
  };

  onRepository("repo:checkout", (repository, target: CheckoutTarget) => repository.checkout(target));
  onRepository("repo:fetch", (repository, login?: GitLogin) => repository.fetch(login));
  onRepository("repo:pull", (repository, login?: GitLogin) => repository.pull(login));
  onRepository("repo:push", (repository, login?: GitLogin) => repository.push(login));
  onRepository("repo:set-remote-url", (repository, remote: string, url: string) =>
    repository.setRemoteUrl(remote, url)
  );
  onRepository("repo:create-branch", (repository, name: string, startPoint: string) =>
    repository.createBranch(name, startPoint)
  );
  onRepository("repo:rename-branch", (repository, from: string, to: string) => repository.renameBranch(from, to));
  onRepository("repo:delete-branch", (repository, name: string, onRemote: boolean) =>
    repository.deleteBranch(name, onRemote)
  );
  onRepository("repo:delete-remote-branch", (repository, remote: string, name: string, login?: GitLogin) =>
    repository.deleteRemoteBranch(remote, name, login)
  );
  onRepository("repo:merge", (repository, ref: string) => repository.merge(ref));
  onRepository("repo:rebase", (repository, ref: string, confirmed: boolean) => repository.rebase(ref, confirmed));
  onRepository("repo:abort", (repository) => repository.abort());
  onRepository("repo:create-tag", (repository, name: string, target: string, message: string) =>
    repository.createTag(name, target, message)
  );
  onRepository("repo:push-tag", (repository, name: string, login?: GitLogin) => repository.pushTag(name, login));
  onRepository("repo:delete-tag", (repository, name: string, onRemote: boolean) =>
    repository.deleteTag(name, onRemote)
  );
  onRepository("repo:delete-remote-tag", (repository, name: string, login?: GitLogin) =>
    repository.deleteRemoteTag(name, login)
  );
  onRepository("repo:checkout-tag", (repository, name: string) => repository.checkoutTag(name));
  onRepository("repo:commit-all", (repository, message: string) => repository.commitAll(message));
  onRepository("repo:commit-paths", (repository, message: string, paths: string[]) =>
    repository.commitPaths(message, paths)
  );
  ipcMain.handle("repo:suggest-commit-message", async (_event, projectId: string, paths?: string[]): Promise<SuggestionResult> => {
    const project = store.get(projectId);
    if (!project) {
      return {};
    }
    const askable = await findAskableAgent(project.path);
    if (!askable) {
      const candidates = AGENTS.filter((agent) => agent.askArgs)
        .map((agent) => agent.displayName)
        .join(" or ");
      return { error: `${candidates} not found — install one to have it suggest a commit message.` };
    }
    const { executable, agent } = askable;
    try {
      // The commit's own paths, a rename's old one included.
      const pathspec = paths && (repositories.get(projectId)?.pathspec(paths) ?? paths);
      const context = await git.readCommitContext(project.path, pathspec);
      const prompt = effectivePrompt(settings.get().prompts, "commitMessage");
      const message = await suggestCommitMessage(project.path, executable, agent.askArgs!, prompt, context);
      return message.length === 0 ? { error: "The agent did not suggest a commit message" } : { value: message };
    } catch (error) {
      return { error: `Could not suggest a commit message: ${errorMessage(error)}` };
    } finally {
      await agent.cleanupAsk?.(executable, project.path).catch(() => undefined);
    }
  });
  onRepository("repo:stash-push", (repository, message: string) => repository.stashPush(message));
  onRepository("repo:stash", (repository, command: StashCommand, sha: string) => repository.stash(command, sha));
  onRepository("repo:discard", async (repository, paths: string[], permanently: boolean) =>
    paths.length > 0 ? repository.discard(paths, permanently) : { ok: true }
  );
  onRepository("repo:ignore", (repository, filePath: string, scope: "file" | "extension") =>
    repository.ignore(filePath, scope)
  );
  onRepository("repo:create-file", (repository, filePath: string) => repository.createFile(filePath));
  onRepository("repo:create-directory", (repository, dirPath: string) => repository.createDirectory(dirPath));
  onRepository("repo:delete-path", (repository, filePath: string) => repository.deletePath(filePath));
  onRepository("repo:rename-path", (repository, fromPath: string, toPath: string) =>
    repository.renamePath(fromPath, toPath)
  );
  onRepository("repo:add-folder", (repository, folderPath: string) => repository.addFolder(folderPath));
  onRepository("repo:remove-folder", (repository, folderPath: string) => repository.removeFolder(folderPath));
  onRepository("repo:exclude-path", (repository, relPath: string) => repository.excludePath(relPath));
  onRepository(
    "repo:set-explorer-setting",
    (repository, key: keyof ExplorerSettings, value: ExplorerSettings[keyof ExplorerSettings]) =>
      repository.setExplorerSetting(key, value)
  );

  ipcMain.handle("repo:explorer", async (_event, projectId: string): Promise<ExplorerListing> => {
    return (
      (await repositories.get(projectId)?.listExplorer()) ?? {
        files: [],
        emptyDirs: [],
        compactFolders: DEFAULT_EXPLORER_VIEW.compactFolders,
        sortOrder: DEFAULT_EXPLORER_VIEW.sortOrder
      }
    );
  });

  ipcMain.handle("repo:search", async (_event, projectId: string, query: FileSearchQuery): Promise<FileSearchResult> => {
    return (await repositories.get(projectId)?.searchFiles(query)) ?? { files: [], truncated: false };
  });

  // The settings Files tab: tet.json's view settings only, no walk.
  ipcMain.handle("repo:explorer-settings", async (_event, projectId: string): Promise<ExplorerSettings> => {
    return (await repositories.get(projectId)?.readExplorerSettings()) ?? DEFAULT_EXPLORER_VIEW;
  });

  ipcMain.handle("repo:watch-files", (_event, projectId: string, paths: string[]): void => {
    repositories.get(projectId)?.watchFiles(paths);
  });

  ipcMain.handle("repo:file-read", async (_event, projectId: string, filePath: string): Promise<FileContent> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return { path: filePath, content: "", mtimeMs: 0, binary: false, tooLarge: false, error: MISSING_REPOSITORY.error };
    }
    return repository.readFile(filePath);
  });

  ipcMain.handle(
    "repo:file-write",
    async (_event, projectId: string, filePath: string, content: string, expectedMtimeMs: number): Promise<FileWriteResult> => {
      const repository = repositories.get(projectId);
      if (!repository) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      return repository.writeFile(filePath, content, expectedMtimeMs);
    }
  );
}
