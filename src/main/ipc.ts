import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, clipboard, dialog, ipcMain, shell } from "electron";
import { AGENTS, findAskableAgent, listAgents } from "./agents";
import { EMPTY_REPOSITORY_STATE } from "../shared/types";
import type {
  AddAccountResult,
  AddRepositoryResult,
  AgentId,
  AppInfo,
  AppSettings,
  CheckoutTarget,
  DiffOptions,
  ExplorerListing,
  ExplorerSettings,
  ExplorerSortOrder,
  FileContent,
  FileDiff,
  FileWriteResult,
  GitActionResult,
  ListRepositoriesResult,
  Project,
  ProviderAccount,
  ProviderId,
  ProjectCommand,
  RepositoryState,
  Requirements,
  StashCommand,
  TerminalDescriptor
} from "../shared/types";
import { PROVIDERS } from "./providers";
import type { AccountStore } from "./providers/accounts";
import { DEFAULT_EXPLORER_VIEW, mergeCommands, readCommands, suggestCommands, suggestQuestion, writeCommands } from "./git/commands";
import { countActivity } from "./event-loop-monitor";
import { git } from "./git/git-client";
import { addProject, removeProject, type ProjectStore } from "./projects";
import type { Repository, RepositoryManager } from "./git/repository";
import { checkRequirements } from "./requirements";
import type { SessionManagerRegistry } from "./terminals/session-manager";
import type { SettingsStore } from "./settings";

/**
 * Everything the renderer can ask the main process for, in one place — main.ts builds these
 * singletons and the window, this is the surface between the two processes. A new capability
 * (the providers, say) is a new block here, not a longer main.ts.
 */
export interface IpcDeps {
  store: ProjectStore;
  settings: SettingsStore;
  accounts: AccountStore;
  repositories: RepositoryManager;
  sessions: SessionManagerRegistry;
  /** Posts to the window, or nowhere while none is open. */
  send: (channel: string, payload: unknown) => void;
  /** Brings a project's repository and terminals up; shared with the bootstrap's restore. */
  openProject: (project: Project) => void;
  /** Opens the stored projects, once and only once the requirements are met. */
  openWorkspace: () => void;
}

const MISSING_REPOSITORY: RepositoryState = { ...EMPTY_REPOSITORY_STATE, error: "Project not found" };

const TEMP_FILE_NAME = /^tet-(\d+)-/;
/** A pasted path is meant to be read within the turn it was typed into — a day is generous. */
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Writes bytes the renderer holds but has no path for to a temp file, and returns it. */
async function writeTempFile(name: string, data: Buffer): Promise<string> {
  const file = path.join(os.tmpdir(), `tet-${Date.now()}-${path.basename(name)}`);
  // Asynchronously: a pasted screenshot is megabytes, and a synchronous write would hold the
  // ptys' output and the keystrokes on their way to them for as long as the disk takes.
  await fs.promises.writeFile(file, data);
  return file;
}

/**
 * Clears what writeTempFile left behind: nothing marks one of its files as "already read", so
 * without this they sit in the OS temp directory forever. Run once at startup rather than after
 * each paste — the file may still be read a moment later, and a session cut short must not take
 * it with it. The write time is in the name already, so this costs one `readdir`, no `stat`.
 */
export function sweepTempFiles(): void {
  void (async () => {
    const dir = os.tmpdir();
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
    await Promise.all(
      names.map(async (name) => {
        const match = TEMP_FILE_NAME.exec(name);
        if (!match || Number(match[1]) >= cutoff) {
          return;
        }
        await fs.promises.unlink(path.join(dir, name)).catch(() => undefined);
      })
    );
  })();
}

export function registerIpc({
  store,
  settings,
  accounts,
  repositories,
  sessions,
  send,
  openProject,
  openWorkspace
}: IpcDeps): void {
  /**
   * The gate the window opens with: nothing is restored until git and an agent are there, so a
   * machine missing one never gets as far as a repository or a terminal. Asked again after
   * every re-check, and passing is what starts the app.
   */
  ipcMain.handle("startup:check", async (): Promise<Requirements> => {
    const requirements = await checkRequirements();
    if (requirements.met) {
      openWorkspace();
    }
    return requirements;
  });

  ipcMain.on("startup:quit", () => app.quit());

  // The Info tab's rows. Every one of them is fixed for the life of the process, so this is
  // asked once when the dialog opens rather than pushed at the renderer.
  ipcMain.handle(
    "app:info",
    (): AppInfo => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      os: `${process.platform} ${process.arch}`
    })
  );

  ipcMain.handle("settings:get", (): AppSettings => settings.get());

  // Written whole, like a project's saved commands: the dialog holds all of it and every
  // switch it draws is one the user could have flipped since it was opened.
  ipcMain.handle("settings:save", (_event, next: AppSettings): void => settings.save(next));

  ipcMain.handle("projects:list", (): Project[] => store.list());

  ipcMain.handle(
    "projects:pick-directory",
    async (_event, title: string, defaultPath?: string): Promise<string | null> => {
      // Undefined rather than "" for a folder nobody has picked yet: an empty defaultPath is a
      // path too, and the platform would open wherever it resolves to.
      const result = await dialog.showOpenDialog({
        title,
        defaultPath: defaultPath === "" ? undefined : defaultPath,
        properties: ["openDirectory"]
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  );

  const projectDeps = { store, repositories, sessions, openProject };

  ipcMain.handle("projects:open-path", (_event, directory: string): Promise<AddRepositoryResult> =>
    addProject(projectDeps, directory)
  );

  /** Clone and create both end the same way: the new folder becomes a project like any picked one. */
  const addRepository = async (
    action: Promise<GitActionResult>,
    directory: string,
    label: string
  ): Promise<AddRepositoryResult> => {
    try {
      const result = await action;
      if (!result.ok) {
        // The dialog asks for an account or a token when this says the credentials were what
        // was missing, so it has to survive the trip rather than be flattened into the message.
        return { error: result.error || `${label} failed`, authRequired: result.authRequired };
      }
    } catch (error) {
      // The git process died mid-command; its message is all that is left to report.
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const project = store.add(directory);
    openProject(project);
    return { project };
  };

  ipcMain.handle("projects:clone", (_event, url: string, directory: string, name: string, accountId?: string) => {
    const target = path.join(directory, name);
    // From the remote tab the account's token authenticates the clone itself — the repository
    // was just listed with it, so the clone must not hinge on a credential helper too.
    const account = accountId !== undefined ? accounts.get(accountId) : undefined;
    const token = accountId !== undefined ? accounts.token(accountId) : undefined;
    const action =
      account && token !== undefined ? git.cloneWithToken(url, target, account.user, token) : git.clone(url, target);
    return addRepository(action, target, "Clone");
  });

  ipcMain.handle("projects:create", (_event, directory: string, name: string) => {
    const target = path.join(directory, name);
    return addRepository(git.init(target), target, "Create");
  });

  ipcMain.handle("providers:accounts", (): ProviderAccount[] => accounts.list());

  ipcMain.handle(
    "providers:add-account",
    async (_event, provider: ProviderId, host: string, token: string): Promise<AddAccountResult> => {
      // "https://gitlab.company.com/" pasted as the host means the host inside it.
      const bare = host
        .trim()
        .replace(/^[a-z]+:\/\//i, "")
        .replace(/\/.*$/, "");
      try {
        const user = await PROVIDERS[provider].validate(bare, token);
        return { account: accounts.add(provider, bare, user, token) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle("providers:remove-account", (_event, accountId: string): void => accounts.remove(accountId));

  ipcMain.handle("providers:set-namespace", (_event, accountId: string, namespace: string): void =>
    accounts.setNamespace(accountId, namespace)
  );

  ipcMain.handle("providers:repos", async (_event, accountId: string): Promise<ListRepositoriesResult> => {
    const account = accounts.get(accountId);
    const token = accounts.token(accountId);
    if (!account || token === undefined) {
      return { error: "The account's token could not be read — add the account again" };
    }
    try {
      return { repos: await PROVIDERS[account.provider].listRepositories(account.host, token) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("projects:reorder", (_event, projectIds: string[]): void => store.reorder(projectIds));

  ipcMain.handle("projects:remove", (_event, projectId: string): void => removeProject(projectDeps, projectId));

  ipcMain.handle("repo:state", (_event, projectId: string): RepositoryState => {
    return repositories.get(projectId)?.getState() ?? MISSING_REPOSITORY;
  });

  ipcMain.handle("repo:refresh", async (_event, projectId: string): Promise<RepositoryState> => {
    return (await repositories.get(projectId)?.refresh()) ?? MISSING_REPOSITORY;
  });

  /**
   * Every command a repository can be asked to run: they all answer a GitActionResult, and
   * they all have nothing to act on when the project is not open.
   */
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
  onRepository("repo:fetch", (repository) => repository.fetch());
  onRepository("repo:pull", (repository) => repository.pull());
  onRepository("repo:push", (repository) => repository.push());
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
  onRepository("repo:merge", (repository, ref: string) => repository.merge(ref));
  onRepository("repo:rebase", (repository, ref: string) => repository.rebase(ref));
  onRepository("repo:abort", (repository) => repository.abort());
  onRepository("repo:create-tag", (repository, name: string, target: string, message: string) =>
    repository.createTag(name, target, message)
  );
  onRepository("repo:push-tag", (repository, name: string) => repository.pushTag(name));
  onRepository("repo:delete-tag", (repository, name: string, onRemote: boolean) =>
    repository.deleteTag(name, onRemote)
  );
  onRepository("repo:checkout-tag", (repository, name: string) => repository.checkoutTag(name));
  onRepository("repo:commit-all", (repository, message: string) => repository.commitAll(message));
  onRepository("repo:stash-push", (repository, message: string) => repository.stashPush(message));
  onRepository("repo:stash", (repository, command: StashCommand, ref: string) => repository.stash(command, ref));
  onRepository("repo:discard", async (repository, paths: string[]) =>
    paths.length > 0 ? repository.discard(paths) : { ok: true }
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
  onRepository("repo:set-exclude-git-ignore", (repository, value: boolean) => repository.setExcludeGitIgnore(value));
  onRepository("repo:set-compact-folders", (repository, value: boolean) => repository.setCompactFolders(value));
  onRepository("repo:set-sort-order", (repository, value: ExplorerSortOrder) => repository.setSortOrder(value));

  ipcMain.handle(
    "repo:diff",
    async (_event, projectId: string, filePath: string, options: DiffOptions): Promise<FileDiff> => {
      const repository = repositories.get(projectId);
      if (!repository) {
        return { path: filePath, lines: [], binary: false, truncated: false, error: MISSING_REPOSITORY.error };
      }
      return repository.diff(filePath, options);
    }
  );

  ipcMain.handle(
    "repo:file-lines",
    async (_event, projectId: string, filePath: string, from: number, to: number): Promise<string[]> => {
      return (await repositories.get(projectId)?.fileLines(filePath, from, to)) ?? [];
    }
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

  // The settings dialog's Files tab: just the three view settings, not a full listing — reads
  // tet.json alone, no filesystem walk.
  ipcMain.handle("repo:explorer-settings", async (_event, projectId: string): Promise<ExplorerSettings> => {
    return (await repositories.get(projectId)?.readExplorerSettings()) ?? DEFAULT_EXPLORER_VIEW;
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

  ipcMain.handle("commands:list", async (_event, projectId: string): Promise<ProjectCommand[] | null> => {
    const project = store.get(projectId);
    return project ? readCommands(project.path) : [];
  });

  ipcMain.handle("commands:save", async (_event, projectId: string, commands: ProjectCommand[]): Promise<void> => {
    const project = store.get(projectId);
    if (!project) {
      return;
    }
    try {
      await writeCommands(project.path, commands);
    } catch (error) {
      send("app:notice", { severity: "error", message: `Could not save commands: ${String(error)}` });
    }
  });

  /**
   * Running one is opening a tab for it: the command is the tab's process.
   */
  ipcMain.handle(
    "commands:run",
    (_event, projectId: string, command: ProjectCommand): TerminalDescriptor | null => {
      return sessions.get(projectId)?.createCommandTab(command) ?? null;
    }
  );

  /**
   * The wand: asks whichever agent is installed what this project can run, and adds what it
   * names to the list. Its answer goes straight in rather than through a review step —
   * whatever it gets wrong is one right-click away from being deleted.
   */
  ipcMain.handle("commands:suggest", async (_event, projectId: string): Promise<ProjectCommand[]> => {
    const project = store.get(projectId);
    if (!project) {
      return [];
    }
    const askable = await findAskableAgent(project.path);
    if (!askable) {
      // Named from the agents themselves rather than spelled out here: which of them can be
      // asked a question is theirs to say, and a third one must not need this line edited.
      const candidates = AGENTS.filter((agent) => agent.askArgs)
        .map((agent) => agent.displayName)
        .join(" or ");
      send("app:notice", {
        severity: "warning",
        message: `${candidates} not found — install one to have it find the commands for you.`
      });
      return [];
    }
    const { executable, agent } = askable;
    try {
      const found = await suggestCommands(project.path, executable, agent.askArgs!, suggestQuestion());
      const existing = (await readCommands(project.path)) ?? [];
      const merged = mergeCommands(existing, found);
      const added = merged.length - existing.length;
      if (added > 0) {
        await writeCommands(project.path, merged);
      }
      send("app:notice", {
        severity: "info",
        message: added > 0 ? `Added ${added} commands` : "No new commands found"
      });
      return merged;
    } catch (error) {
      send("app:notice", { severity: "error", message: `Could not read the project: ${String(error)}` });
      return [];
    } finally {
      // Whether it answered or not, it may have persisted a session on the way — and one
      // nobody opened has no business showing up as a tab after the next restart.
      await agent.cleanupAsk?.(executable, project.path).catch(() => undefined);
    }
  });

  ipcMain.handle("terminal:list", (_event, projectId: string): TerminalDescriptor[] => {
    return sessions.get(projectId)?.snapshot() ?? [];
  });

  ipcMain.handle("terminal:create", (_event, projectId: string, agentId: AgentId): TerminalDescriptor => {
    const manager = sessions.get(projectId);
    if (!manager) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return manager.createTab(agentId);
  });

  ipcMain.handle("terminal:close", async (_event, projectId: string, tabIds: string[]): Promise<void> => {
    await sessions.get(projectId)?.closeTabs(tabIds);
  });

  ipcMain.handle("terminal:rename", async (_event, projectId: string, tabId: string, title: string): Promise<void> => {
    await sessions.get(projectId)?.renameTab(tabId, title);
  });

  ipcMain.handle("terminal:restart", (_event, projectId: string, tabId: string): void => {
    sessions.get(projectId)?.restartTab(tabId);
  });

  /**
   * The tab is in front of the user, so the mark a finished turn left on it goes away. Only
   * the renderer knows which tab that is, hence the call rather than a rule applied here.
   */
  ipcMain.on("terminal:seen", (_event, projectId: string, tabId: string) => {
    sessions.get(projectId)?.markSeen(tabId);
  });

  ipcMain.on("terminal:input", (_event, projectId: string, tabId: string, data: string) => {
    countActivity("input");
    sessions.get(projectId)?.write(tabId, data);
  });

  ipcMain.on("terminal:resize", (_event, projectId: string, tabId: string, cols: number, rows: number) => {
    sessions.get(projectId)?.handleResize(tabId, cols, rows);
  });

  ipcMain.handle("terminal:starting", (_event, projectId: string): boolean => {
    return sessions.get(projectId)?.isStarting() ?? false;
  });

  ipcMain.handle("terminal:resolve-url", async (_event, projectId: string, tabId: string, fragment: string) => {
    return (await sessions.get(projectId)?.resolveUrlPrefix(tabId, fragment)) ?? null;
  });

  ipcMain.handle("agents:list", () => listAgents());

  ipcMain.handle("shell:open-url", async (_event, url: string): Promise<void> => {
    try {
      await shell.openExternal(url);
    } catch (error) {
      send("app:notice", { severity: "error", message: `Could not open URL: ${url} (${String(error)})` });
    }
  });

  /**
   * A path the user ctrl-clicked in a terminal. A file inside the repository is answered with
   * its repository-relative path, which the renderer opens in the diff dialog (as a diff when
   * it has local changes, as plain content otherwise); anything else is handed to the OS here,
   * where the filesystem actually is.
   */
  ipcMain.handle("shell:open-file", async (_event, projectId: string, rawPath: string): Promise<string | null> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return null;
    }
    const expanded =
      rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")
        ? path.join(os.homedir(), rawPath.slice(1))
        : rawPath;
    const root = repository.project.path;
    const resolved = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
    const isFile = await fs.promises
      .stat(resolved)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!isFile) {
      send("app:notice", { severity: "error", message: `Could not find file: ${rawPath}` });
      return null;
    }
    // git reports every path relative to the root with forward slashes, so match in that shape.
    const relativeRaw = path.relative(root, resolved);
    if (relativeRaw !== "" && !relativeRaw.startsWith("..") && !path.isAbsolute(relativeRaw)) {
      return relativeRaw.replace(/\\/g, "/");
    }
    const error = await shell.openPath(resolved);
    if (error) {
      send("app:notice", { severity: "error", message: `Could not open file: ${rawPath} (${error})` });
    }
    return null;
  });

  /** A changed file shown in the OS file manager — the git pane's context menu. */
  ipcMain.handle("shell:reveal-file", (_event, projectId: string, filePath: string): void => {
    const repository = repositories.get(projectId);
    if (repository) {
      shell.showItemInFolder(path.join(repository.project.path, filePath));
    }
  });

  /**
   * The changed-file menu's "Open in external editor". tet has no editor setting, so the
   * file goes to whatever the OS opens its type with — which on a developer's machine is the
   * editor GitHub Desktop would have asked about.
   */
  ipcMain.handle("shell:open-file-externally", async (_event, projectId: string, filePath: string): Promise<void> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return;
    }
    const error = await shell.openPath(path.join(repository.project.path, filePath));
    if (error) {
      send("app:notice", { severity: "error", message: `Could not open file: ${filePath} (${error})` });
    }
  });

  ipcMain.handle("shell:open-project", async (_event, projectId: string): Promise<void> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return;
    }
    const error = await shell.openPath(repository.project.path);
    if (error) {
      send("app:notice", { severity: "error", message: `Could not open folder: ${repository.project.path} (${error})` });
    }
  });

  ipcMain.handle("files:write-temp", (_event, name: string, dataBase64: string): Promise<string> => {
    return writeTempFile(name, Buffer.from(dataBase64, "base64"));
  });

  /** The clipboard's image as a file on disk, so its path can be typed into a CLI. */
  ipcMain.handle("clipboard:image-file", (): Promise<string> | null => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : writeTempFile(`pasted-image-${Date.now()}.png`, image.toPNG());
  });
}
