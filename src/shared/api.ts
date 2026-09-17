import type {
  AddAccountResult,
  AddRepositoryResult,
  AgentId,
  AgentInfo,
  AppInfo,
  AppSettings,
  CheckoutTarget,
  EditorReport,
  ExplorerListing,
  ExplorerSettings,
  FileContent,
  FileWriteResult,
  GitActionResult,
  ListRepositoriesResult,
  Notice,
  NoticeReport,
  Project,
  ProjectCommand,
  ProviderAccount,
  ProviderId,
  RepositoryState,
  Requirements,
  SbxPath,
  SbxProjectConfig,
  SbxStatus,
  StashCommand,
  TerminalDescriptor,
  TerminalOutput,
  TerminalStatus
} from "./types";

export type Unsubscribe = () => void;

export interface TETApi {
  /** The programs tet cannot run without; the app shows only once they are there. */
  startup: {
    /** Runs the check and, when it passes, brings the stored projects up. */
    check(): Promise<Requirements>;
    /** Whether any agent CLI is installed now — what makes a project sbx-only. Spawns the checks
     *  fresh: ask where tet already refreshes host state, never on a timer. */
    anyAgentInstalled(): Promise<boolean>;
    /** For the user who would rather install first. */
    quit(): void;
  };
  app: {
    /** The settings dialog's Info tab. */
    info(): Promise<AppInfo>;
    /** A task that held the renderer's thread — into the main process's event loop log. */
    reportLongTask(ms: number, context: string): void;
    /** A named renderer block that ran long — into the same log. */
    reportSlow(label: string, ms: number): void;
    /** For `tet-ctl notices-list`. */
    reportNotice(report: NoticeReport): void;
  };
  /** Docker Sandboxes, opt-in per project through the project row's "SBX Settings". */
  sbx: {
    /** All the dialog checks before showing its fields. Never cached, PATH re-read first — "Check
     *  again" follows an install. Per project: the policy must allow the project's folder. */
    status(projectId: string): Promise<SbxStatus>;
    /** Opens the OAuth page in the browser and waits; no terminal. */
    login(): Promise<boolean>;
    /** Sets the machine-wide network policy to "balanced", Docker's recommended default. */
    initPolicy(): Promise<boolean>;
    /** Kills a running `login`/`initPolicy` — the Cancel button. */
    cancelSetup(): void;
    /** From tet.json, the hosts from the sandboxes themselves. */
    getConfig(projectId: string): Promise<SbxProjectConfig>;
    /** Writes tet.json; a sandbox whose folders changed is removed. */
    saveConfig(projectId: string, request: SbxProjectConfig): Promise<GitActionResult>;
    /** Per entry, whether sbx's filesystem policy lets it be mounted with its access. */
    mountsAllowed(paths: SbxPath[]): Promise<boolean[]>;
  };
  /** One set for the whole app. */
  settings: {
    get(): Promise<AppSettings>;
    /** Writes all of it. A switch applies to agents set up after it. */
    save(settings: AppSettings): Promise<void>;
  };
  projects: {
    list(): Promise<Project[]>;
    /** Native folder picker opening at `defaultPath`; null when cancelled. */
    pickDirectory(title: string, defaultPath?: string): Promise<string | null>;
    /** Separate because only macOS honours both modes in one dialog. */
    pickFile(title: string): Promise<string | null>;
    /** Where the folder picker opens next: `directory`, or its parent when it is a repository root. */
    directoryToRemember(directory: string): Promise<string>;
    /** Opens the folder, or its enclosing repository; a missing one is an error. */
    open(directory: string): Promise<AddRepositoryResult>;
    /** `git clone` into `directory`/`name`; an account's token authenticates it. */
    clone(url: string, directory: string, name: string, accountId?: string): Promise<AddRepositoryResult>;
    /** `git init` of `directory`/`name`, opened as a project. */
    create(directory: string, name: string): Promise<AddRepositoryResult>;
    remove(projectId: string): Promise<void>;
    /** The full dragged order of ids. */
    reorder(projectIds: string[]): Promise<void>;
    /** The control channel opened or closed a project. */
    onChanged(listener: (payload: { projects: Project[]; added?: string; removed?: string }) => void): Unsubscribe;
  };
  providers: {
    accounts(): Promise<ProviderAccount[]>;
    /** Validates the token against the host and stores it main-side. */
    addAccount(provider: ProviderId, host: string, token: string): Promise<AddAccountResult>;
    removeAccount(accountId: string): Promise<void>;
    /** The remote tab's group filter; "" (all) is a choice too. */
    setNamespace(accountId: string, namespace: string): Promise<void>;
    /** Most recently active first. */
    repos(accountId: string): Promise<ListRepositoriesResult>;
  };
  repository: {
    state(projectId: string): Promise<RepositoryState>;
    refresh(projectId: string): Promise<RepositoryState>;
    checkout(projectId: string, target: CheckoutTarget): Promise<GitActionResult>;
    /** `git fetch --prune`. Also runs quietly every ten minutes. */
    fetch(projectId: string): Promise<GitActionResult>;
    pull(projectId: string): Promise<GitActionResult>;
    /** Sets the upstream when there is none ("publish"). */
    push(projectId: string): Promise<GitActionResult>;
    /** The new url shows in the next state. */
    setRemoteUrl(projectId: string, remote: string, url: string): Promise<GitActionResult>;
    /** Creates the branch off `startPoint` and switches to it. */
    createBranch(projectId: string, name: string, startPoint: string): Promise<GitActionResult>;
    renameBranch(projectId: string, from: string, to: string): Promise<GitActionResult>;
    /** The caller confirms first. */
    deleteBranch(projectId: string, name: string, onRemote: boolean): Promise<GitActionResult>;
    /** Into the current branch. A conflict is reported and left in the tree. */
    merge(projectId: string, ref: string): Promise<GitActionResult>;
    rebase(projectId: string, ref: string): Promise<GitActionResult>;
    /** Aborts `RepositoryState.operation`. */
    abort(projectId: string): Promise<GitActionResult>;
    /** Annotated with a message, lightweight without. */
    createTag(projectId: string, name: string, target: string, message: string): Promise<GitActionResult>;
    pushTag(projectId: string, name: string): Promise<GitActionResult>;
    deleteTag(projectId: string, name: string, onRemote: boolean): Promise<GitActionResult>;
    /** Leaves HEAD detached. */
    checkoutTag(projectId: string, name: string): Promise<GitActionResult>;
    /** Everything the changes list shows, untracked included. */
    commitAll(projectId: string, message: string): Promise<GitActionResult>;
    /** These files alone, untracked included; nothing else staged goes with them. */
    commitPaths(projectId: string, message: string, paths: string[]): Promise<GitActionResult>;
    /** An installed agent suggests one subject for all changes, or only `paths`. */
    suggestCommitMessage(projectId: string, paths?: string[]): Promise<string>;
    /** Everything the changes list shows, untracked included. */
    stashPush(projectId: string, message: string): Promise<GitActionResult>;
    /** The ref is a position — only ever a freshly read one. */
    stash(projectId: string, command: StashCommand, ref: string): Promise<GitActionResult>;
    /** The caller confirms first. */
    discard(projectId: string, paths: string[]): Promise<GitActionResult>;
    /** Appends the file, or its extension, to .gitignore. */
    ignore(projectId: string, path: string, scope: "file" | "extension"): Promise<GitActionResult>;
    /** With parent directories — the Explorer's "New File...". */
    createFile(projectId: string, path: string): Promise<GitActionResult>;
    /** The Explorer's "New Folder...". */
    createDirectory(projectId: string, path: string): Promise<GitActionResult>;
    /** To the trash — the Explorer's "Delete...". */
    deletePath(projectId: string, path: string): Promise<GitActionResult>;
    /** The Explorer's "Rename...". */
    renamePath(projectId: string, from: string, to: string): Promise<GitActionResult>;
    /** tet.json's `folders` — "Add Folder to Workspace". */
    addFolder(projectId: string, path: string): Promise<GitActionResult>;
    /** Removing the last one restores the whole repository as one tree. */
    removeFolder(projectId: string, path: string): Promise<GitActionResult>;
    /** tet.json's `settings["files.exclude"]` — "Exclude from Files". */
    excludePath(projectId: string, path: string): Promise<GitActionResult>;
    /** A file-only view setting, from the settings dialog's Files tab. */
    setExplorerSetting<K extends keyof ExplorerSettings>(
      projectId: string,
      key: K,
      value: ExplorerSettings[K]
    ): Promise<GitActionResult>;
    listExplorer(projectId: string): Promise<ExplorerListing>;
    /** tet.json alone, no filesystem walk. */
    explorerSettings(projectId: string): Promise<ExplorerSettings>;
    readFile(projectId: string, path: string): Promise<FileContent>;
    /** Nothing is written unless `expectedMtimeMs` matches the disk. */
    writeFile(projectId: string, path: string, content: string, expectedMtimeMs: number): Promise<FileWriteResult>;
    /** Git command, file watcher or refresh. */
    onState(listener: (payload: { projectId: string; state: RepositoryState }) => void): Unsubscribe;
    /** A working-tree entry appeared or vanished — ignored ones included, which no state reports. */
    onFilesChanged(listener: (payload: { projectId: string }) => void): Unsubscribe;
    /** The editor tabs' files, for `onFileChanged`; the whole set each time. */
    watchFiles(projectId: string, paths: string[]): Promise<void>;
    /** A `watchFiles` file was written, by anyone. */
    onFileChanged(listener: (payload: { projectId: string; path: string }) => void): Unsubscribe;
    /** For `tet-ctl editor-state` and `editor-list`; null once the tab is closed. */
    reportEditor(projectId: string, tabId: string, report: EditorReport | null): void;
    /** The project's active editor tab, which `editor-state` answers for — the window's layout knows. */
    reportActiveEditor(projectId: string, tabId: string): void;
    /** `tet-ctl editor-state` asks for the active editor tab's text; the listener answers. */
    onEditorContentRequest(listener: (projectId: string) => string | undefined): Unsubscribe;
    /** `tet-ctl editor-open`: in the preview tab, or kept with `--keep`. */
    onOpenEditor(listener: (payload: { projectId: string; path: string; keep: boolean }) => void): Unsubscribe;
  };
  /** Saved shell commands, in the project root's tet.json so they travel with it. */
  commands: {
    list(projectId: string): Promise<ProjectCommand[]>;
    /** The whole list; add, remove and reorder all go through here. */
    save(projectId: string, commands: ProjectCommand[]): Promise<void>;
    /** A tab whose process is the command; null when nothing can run it. */
    run(projectId: string, command: ProjectCommand): Promise<TerminalDescriptor | null>;
    /** tet.json changed on disk, whoever wrote it. */
    onChanged(listener: (payload: { projectId: string }) => void): Unsubscribe;
  };
  terminals: {
    list(projectId: string): Promise<TerminalDescriptor[]>;
    /** The session starts on first resize. */
    create(projectId: string, agentId: AgentId): Promise<TerminalDescriptor>;
    /** Also deletes the sessions behind them. */
    close(projectId: string, tabIds: string[]): Promise<void>;
    rename(projectId: string, tabId: string, title: string): Promise<void>;
    /** Respawns a saved command in the same tab. */
    restart(projectId: string, tabId: string): Promise<void>;
    /** Clears `finishedAt` — only the renderer knows which tab is in front. */
    seen(projectId: string, tabId: string): void;
    /** The shown project's tabs in front of the user (on screen, focused window, no dialog); a turn
     *  there raises no toast. Sent whenever the set changes. */
    inFront(projectId: string | null, tabIds: string[]): void;
    input(projectId: string, tabId: string, data: string): void;
    /** The first resize starts the process (lazy spawn). */
    resize(projectId: string, tabId: string, cols: number, rows: number): void;
    /** The full url of a wrapped fragment; null means no answer — do not re-ask. */
    resolveUrl(projectId: string, tabId: string, fragment: string): Promise<string | null>;
    /** The project's full tab list on every change. */
    onTabs(listener: (payload: { projectId: string; tabs: TerminalDescriptor[] }) => void): Unsubscribe;
    /** One message per flush for all terminals. */
    onOutput(listener: (batch: TerminalOutput[]) => void): Unsubscribe;
    onStatus(
      listener: (payload: { projectId: string; tabId: string; status: TerminalStatus }) => void
    ): Unsubscribe;
    /** Anything in the project still starting (a CLI booting, sessions listing). */
    onStartupProgress(listener: (payload: { projectId: string; show: boolean }) => void): Unsubscribe;
    /** A tab the control channel opened, to bring to front. */
    onShow(listener: (payload: { projectId: string; tabId: string }) => void): Unsubscribe;
    /** onStartupProgress's current value: a project restored at start bootstraps before the window. */
    starting(projectId: string): Promise<boolean>;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
  };
  files: {
    /** A dropped file's real path, or "" for content only. */
    pathOf(file: File): string;
    /** Saves pathless content to a temp file, returning its path. */
    writeTemp(name: string, dataBase64: string): Promise<string>;
    /** The clipboard image as a temp file; null without one. */
    clipboardImage(): Promise<string | null>;
  };
  shell: {
    openUrl(url: string): Promise<void>;
    /** A path activated in a terminal: the repository-relative path for a file inside the
     *  repository, null when handed to the OS. */
    openFile(projectId: string, path: string): Promise<string | null>;
    /** Selected in the OS file manager. */
    revealFile(projectId: string, path: string): Promise<void>;
    /** With the OS's default app for the type. */
    openFileExternally(projectId: string, path: string): Promise<void>;
    /** In the OS file manager. */
    openProject(projectId: string): Promise<void>;
  };
  /** What the main process wants said — see Notice. */
  onNotice(listener: (payload: Notice) => void): Unsubscribe;
  /** Read synchronously off `webPreferences.additionalArguments` before main.tsx runs: an async read
   *  would draw the first frame in the wrong colors. */
  initialTheme: string;
  /** From main.ts's `applyTheme`, and after every page load. */
  onTheme(listener: (themeId: string) => void): Unsubscribe;
  /** main.ts's `isWaylandSession`, handed in the same way; terminals stay off WebGL there. */
  waylandSession: boolean;
}
