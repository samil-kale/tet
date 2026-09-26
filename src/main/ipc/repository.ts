import { ipcMain } from "electron";
import { AGENTS, findAskableAgent } from "../agents";
import { effectivePrompt } from "../../shared/prompts";
import { errorMessage } from "../../shared/errors";
import type {
  CheckoutRef,
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
  settings,
  repositories
}: Pick<IpcDeps, "settings" | "repositories">): void {
  ipcMain.handle("repository:state", (_event, checkout: CheckoutRef): RepositoryState => {
    return repositories.get(checkout)?.getState() ?? MISSING_REPOSITORY;
  });

  ipcMain.handle("repository:refresh", (_event, checkout: CheckoutRef): void => {
    repositories.get(checkout)?.refreshSoon();
  });

  /** A repository command answering a GitActionResult, or an error when the checkout is not open. */
  const onRepository = <A extends unknown[]>(
    channel: string,
    run: (repository: Repository, ...args: A) => Promise<GitActionResult>
  ): void => {
    ipcMain.handle(channel, async (_event, checkout: CheckoutRef, ...args: A): Promise<GitActionResult> => {
      const repository = repositories.get(checkout);
      return repository ? run(repository, ...args) : { ok: false, error: MISSING_REPOSITORY.error };
    });
  };

  /** A write to the project's tet.json, which only its main worktree has (tet-json.ts's configRoot). */
  const onProjectFile = <A extends unknown[]>(
    channel: string,
    run: (repository: Repository, ...args: A) => Promise<GitActionResult>
  ): void => {
    ipcMain.handle(channel, async (_event, projectId: string, ...args: A): Promise<GitActionResult> => {
      const repository = repositories.get({ projectId });
      return repository ? run(repository, ...args) : { ok: false, error: MISSING_REPOSITORY.error };
    });
  };

  onRepository("repository:checkout", (repository, target: CheckoutTarget) => repository.checkout(target));
  onRepository("repository:fetch", (repository, login?: GitLogin) => repository.fetch(login));
  onRepository("repository:pull", (repository, login?: GitLogin) => repository.pull(login));
  onRepository("repository:push", (repository, login?: GitLogin) => repository.push(login));
  onRepository("repository:set-remote-url", (repository, remote: string, url: string) =>
    repository.setRemoteUrl(remote, url)
  );
  onRepository("repository:create-branch", (repository, name: string, startPoint: string) =>
    repository.createBranch(name, startPoint)
  );
  onRepository("repository:rename-branch", (repository, from: string, to: string) => repository.renameBranch(from, to));
  onRepository("repository:delete-branch", (repository, name: string, onRemote: boolean) =>
    repository.deleteBranch(name, onRemote)
  );
  onRepository("repository:delete-remote-branch", (repository, remote: string, name: string, login?: GitLogin) =>
    repository.deleteRemoteBranch(remote, name, login)
  );
  onRepository("repository:merge", (repository, ref: string) => repository.merge(ref));
  onRepository("repository:rebase", (repository, ref: string, confirmed: boolean) => repository.rebase(ref, confirmed));
  onRepository("repository:abort", (repository) => repository.abort());
  onRepository("repository:create-tag", (repository, name: string, target: string, message: string) =>
    repository.createTag(name, target, message)
  );
  onRepository("repository:push-tag", (repository, name: string, login?: GitLogin) => repository.pushTag(name, login));
  onRepository("repository:delete-tag", (repository, name: string, onRemote: boolean) =>
    repository.deleteTag(name, onRemote)
  );
  onRepository("repository:delete-remote-tag", (repository, name: string, login?: GitLogin) =>
    repository.deleteRemoteTag(name, login)
  );
  onRepository("repository:checkout-tag", (repository, name: string) => repository.checkoutTag(name));
  onRepository("repository:commit-all", (repository, message: string) => repository.commitAll(message));
  onRepository("repository:commit-paths", (repository, message: string, paths: string[]) =>
    repository.commitPaths(message, paths)
  );
  ipcMain.handle("repository:suggest-commit-message", async (_event, checkout: CheckoutRef, paths?: string[]): Promise<SuggestionResult> => {
    const repository = repositories.get(checkout);
    if (!repository) {
      return {};
    }
    const cwd = repository.at.path;
    const askable = await findAskableAgent(cwd);
    if (!askable) {
      const candidates = AGENTS.filter((agent) => agent.askArgs)
        .map((agent) => agent.displayName)
        .join(" or ");
      return { error: `${candidates} not found — install one to have it suggest a commit message.` };
    }
    const { executable, agent } = askable;
    try {
      // The commit's own paths, a rename's old one included.
      const pathspec = paths && repository.pathspec(paths);
      const context = await git.readCommitContext(cwd, pathspec);
      const prompt = effectivePrompt(settings.get().prompts, "commitMessage");
      const message = await suggestCommitMessage(cwd, executable, agent.askArgs!, prompt, context);
      return message.length === 0 ? { error: "The agent did not suggest a commit message" } : { value: message };
    } catch (error) {
      return { error: `Could not suggest a commit message: ${errorMessage(error)}` };
    } finally {
      await agent.cleanupAsk?.(executable, cwd).catch(() => undefined);
    }
  });
  onRepository("repository:stash-push", (repository, message: string) => repository.stashPush(message));
  onRepository("repository:stash", (repository, command: StashCommand, sha: string) => repository.stash(command, sha));
  onRepository("repository:discard", async (repository, paths: string[], permanently: boolean) =>
    paths.length > 0 ? repository.discard(paths, permanently) : { ok: true }
  );
  onRepository("repository:ignore", (repository, filePath: string, scope: "file" | "extension") =>
    repository.ignore(filePath, scope)
  );
  onRepository("repository:create-file", (repository, filePath: string) => repository.createFile(filePath));
  onRepository("repository:create-directory", (repository, dirPath: string) => repository.createDirectory(dirPath));
  onRepository("repository:delete-path", (repository, filePath: string) => repository.deletePath(filePath));
  onRepository("repository:rename-path", (repository, fromPath: string, toPath: string) =>
    repository.renamePath(fromPath, toPath)
  );
  onProjectFile("repository:add-folder", (repository, folderPath: string) => repository.addFolder(folderPath));
  onProjectFile("repository:remove-folder", (repository, folderPath: string) => repository.removeFolder(folderPath));
  onProjectFile("repository:exclude-path", (repository, relPath: string) => repository.excludePath(relPath));
  onProjectFile(
    "repository:set-explorer-setting",
    (repository, key: keyof ExplorerSettings, value: ExplorerSettings[keyof ExplorerSettings]) =>
      repository.setExplorerSetting(key, value)
  );

  ipcMain.handle("repository:list-explorer", async (_event, checkout: CheckoutRef): Promise<ExplorerListing> => {
    return (
      (await repositories.get(checkout)?.listExplorer()) ?? {
        files: [],
        emptyDirs: [],
        compactFolders: DEFAULT_EXPLORER_VIEW.compactFolders,
        sortOrder: DEFAULT_EXPLORER_VIEW.sortOrder
      }
    );
  });

  ipcMain.handle("repository:search-files", async (_event, checkout: CheckoutRef, query: FileSearchQuery): Promise<FileSearchResult> => {
    return (await repositories.get(checkout)?.searchFiles(query)) ?? { files: [], truncated: false };
  });

  // The settings Files tab: tet.json's view settings only, no walk.
  ipcMain.handle("repository:explorer-settings", async (_event, projectId: string): Promise<ExplorerSettings> => {
    return (await repositories.get({ projectId })?.readExplorerSettings()) ?? DEFAULT_EXPLORER_VIEW;
  });

  ipcMain.handle("repository:watch-files", (_event, checkout: CheckoutRef, paths: string[]): void => {
    repositories.get(checkout)?.watchFiles(paths);
  });

  ipcMain.handle("repository:read-file", async (_event, checkout: CheckoutRef, filePath: string): Promise<FileContent> => {
    const repository = repositories.get(checkout);
    if (!repository) {
      return { path: filePath, content: "", mtimeMs: 0, binary: false, tooLarge: false, error: MISSING_REPOSITORY.error };
    }
    return repository.readFile(filePath);
  });

  ipcMain.handle(
    "repository:write-file",
    async (_event, checkout: CheckoutRef, filePath: string, content: string, expectedMtimeMs: number): Promise<FileWriteResult> => {
      const repository = repositories.get(checkout);
      if (!repository) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      return repository.writeFile(filePath, content, expectedMtimeMs);
    }
  );
}
