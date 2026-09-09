import type {
  AddAccountResult,
  AddRepositoryResult,
  AgentId,
  AgentInfo,
  AppInfo,
  AppSettings,
  CheckoutTarget,
  DiffOptions,
  ExplorerListing,
  ExplorerSettings,
  FileContent,
  FileDiff,
  FileWriteResult,
  GitActionResult,
  ListRepositoriesResult,
  Notice,
  Project,
  ProjectCommand,
  ProviderAccount,
  ProviderId,
  RepositoryState,
  Requirements,
  SbxProjectConfig,
  SbxStatus,
  StashCommand,
  TerminalDescriptor,
  TerminalOutput,
  TerminalStatus
} from "./types";

/** Removes a listener registered through one of the `on*` methods. */
export type Unsubscribe = () => void;

export interface TETApi {
  /** The programs tet cannot run without; the window shows the app only once they are there. */
  startup: {
    /** Runs the check and, when it passes, brings the stored projects up. */
    check(): Promise<Requirements>;
    /** Leaves, for the user who would rather install first. */
    quit(): void;
  };
  /** What tet is rather than what it is set to; the settings dialog's Info tab shows it. */
  app: {
    info(): Promise<AppInfo>;
    /** A task that held the renderer's thread — into the main process's event loop log. */
    reportLongTask(ms: number, context: string): void;
  };
  /** Docker Sandboxes, opt-in per project — see the project row's "Enable sbx" entry. */
  sbx: {
    /** Everything the dialog asks before showing its fields, in one call. Never cached, PATH
     *  re-read first — "Check again" is pressed right after installing. */
    status(): Promise<SbxStatus>;
    /** Opens the OAuth page in the user's browser and waits for it; no terminal of its own. */
    login(): Promise<boolean>;
    /** Sets the machine-wide network policy to "balanced", Docker's own recommended default. */
    initPolicy(): Promise<boolean>;
    /** Kills whichever of `login`/`initPolicy` is currently running — the Cancel button. */
    cancelSetup(): void;
    /** What the dialog's fields reopen with — tet.json, the hosts from the sandboxes themselves. */
    getConfig(projectId: string): Promise<SbxProjectConfig>;
    /** The dialog's Save button — writes to tet.json; a sandbox whose folders changed is removed. */
    saveConfig(projectId: string, request: SbxProjectConfig): Promise<GitActionResult>;
  };
  /** What the settings dialog reads and writes; there is one set of them for the whole app. */
  settings: {
    get(): Promise<AppSettings>;
    /** Writes all of it. Each switch applies to the agents set up after it — see the dialog. */
    save(settings: AppSettings): Promise<void>;
  };
  projects: {
    list(): Promise<Project[]>;
    /** Opens a native folder picker; null when cancelled. `defaultPath` is the folder it opens in. */
    pickDirectory(title: string, defaultPath?: string): Promise<string | null>;
    /** The same for a single file; separate because only macOS honours both modes as one dialog. */
    pickFile(title: string): Promise<string | null>;
    /** Where the folder picker opens next time: `directory` itself, or its parent when that is a
     *  repository root. */
    directoryToRemember(directory: string): Promise<string>;
    /** Opens the folder — or the repository it is inside — as a project; a missing one is an error. */
    open(directory: string): Promise<AddRepositoryResult>;
    /** `git clone` into a new folder `name` inside `directory`; an account's token authenticates it. */
    clone(url: string, directory: string, name: string, accountId?: string): Promise<AddRepositoryResult>;
    /** `git init` of a new folder `name` inside `directory`, which becomes a project. */
    create(directory: string, name: string): Promise<AddRepositoryResult>;
    remove(projectId: string): Promise<void>;
    /** Persists the order the user dragged them into, as the full list of ids. */
    reorder(projectIds: string[]): Promise<void>;
    /** The list changed without the window asking — the control channel opened or closed a project. */
    onChanged(listener: (payload: { projects: Project[]; added?: string; removed?: string }) => void): Unsubscribe;
  };
  /** The configured repository-host accounts and what the remote tab asks them. */
  providers: {
    accounts(): Promise<ProviderAccount[]>;
    /** Validates the token against the host and stores the account; the token stays main-side. */
    addAccount(provider: ProviderId, host: string, token: string): Promise<AddAccountResult>;
    removeAccount(accountId: string): Promise<void>;
    /** Keeps the group the remote tab was narrowed to; "" is all of them, and is a choice too. */
    setNamespace(accountId: string, namespace: string): Promise<void>;
    /** Every repository the account can reach, most recently active first. */
    repos(accountId: string): Promise<ListRepositoriesResult>;
  };
  repository: {
    state(projectId: string): Promise<RepositoryState>;
    refresh(projectId: string): Promise<RepositoryState>;
    checkout(projectId: string, target: CheckoutTarget): Promise<GitActionResult>;
    /** `git fetch --prune`. Also runs on its own every ten minutes, quietly. */
    fetch(projectId: string): Promise<GitActionResult>;
    pull(projectId: string): Promise<GitActionResult>;
    /** Pushes the current branch, setting its upstream when it has none ("publish"). */
    push(projectId: string): Promise<GitActionResult>;
    /** Points a remote somewhere else; the new url is in the next state. */
    setRemoteUrl(projectId: string, remote: string, url: string): Promise<GitActionResult>;
    /** Creates the branch off `startPoint` and switches to it. */
    createBranch(projectId: string, name: string, startPoint: string): Promise<GitActionResult>;
    renameBranch(projectId: string, from: string, to: string): Promise<GitActionResult>;
    /** Deletes it locally and, when asked, on the remote too; the caller confirms first. */
    deleteBranch(projectId: string, name: string, onRemote: boolean): Promise<GitActionResult>;
    /** Merges the ref into the current branch. A conflict is reported and left in the tree. */
    merge(projectId: string, ref: string): Promise<GitActionResult>;
    rebase(projectId: string, ref: string): Promise<GitActionResult>;
    /** Takes back the merge or rebase in `RepositoryState.operation`. */
    abort(projectId: string): Promise<GitActionResult>;
    /** Annotated when there is a message, lightweight when there is not. */
    createTag(projectId: string, name: string, target: string, message: string): Promise<GitActionResult>;
    pushTag(projectId: string, name: string): Promise<GitActionResult>;
    deleteTag(projectId: string, name: string, onRemote: boolean): Promise<GitActionResult>;
    /** A tag names a commit, so this leaves HEAD detached. */
    checkoutTag(projectId: string, name: string): Promise<GitActionResult>;
    /** Commits everything the changes list shows, untracked files included. */
    commitAll(projectId: string, message: string): Promise<GitActionResult>;
    /** Has an installed agent inspect all current changes and suggest one commit subject. */
    suggestCommitMessage(projectId: string): Promise<string>;
    /** Stashes everything the changes list shows, untracked files included. */
    stashPush(projectId: string, message: string): Promise<GitActionResult>;
    /** Applies, pops or drops one. The ref is a position — only ever a freshly read one. */
    stash(projectId: string, command: StashCommand, ref: string): Promise<GitActionResult>;
    /** Throws the local changes to these files away; the caller confirms first. */
    discard(projectId: string, paths: string[]): Promise<GitActionResult>;
    /** Appends the file, or its whole extension, to the repository's .gitignore. */
    ignore(projectId: string, path: string, scope: "file" | "extension"): Promise<GitActionResult>;
    /** An empty file, parent directories created with it — the Explorer tree's "New File...". */
    createFile(projectId: string, path: string): Promise<GitActionResult>;
    /** An empty directory — the Explorer tree's "New Folder...". */
    createDirectory(projectId: string, path: string): Promise<GitActionResult>;
    /** Moves a file or directory to the trash — the Explorer tree's "Delete...". */
    deletePath(projectId: string, path: string): Promise<GitActionResult>;
    /** Renames or moves a file or directory — the Explorer tree's "Rename...". */
    renamePath(projectId: string, from: string, to: string): Promise<GitActionResult>;
    /** Adds a folder to the project's `folders` list in tet.json — "Add Folder to Workspace". */
    addFolder(projectId: string, path: string): Promise<GitActionResult>;
    /** Removes one again; the last one gone restores the whole repository as one tree. */
    removeFolder(projectId: string, path: string): Promise<GitActionResult>;
    /** Adds the path to the project's `exclude` map in tet.json — "Exclude from Files". */
    excludePath(projectId: string, path: string): Promise<GitActionResult>;
    /** One of the file-only view settings, set from the settings dialog's Files tab. */
    setExplorerSetting<K extends keyof ExplorerSettings>(
      projectId: string,
      key: K,
      value: ExplorerSettings[K]
    ): Promise<GitActionResult>;
    diff(projectId: string, path: string, options: DiffOptions): Promise<FileDiff>;
    /** Lines `from` to `to` of the file as it is now, for a gap the diff view opens. */
    fileLines(projectId: string, path: string, from: number, to: number): Promise<string[]>;
    /** Every file in the repository plus any directory nothing else implies — the Explorer tree. */
    listExplorer(projectId: string): Promise<ExplorerListing>;
    /** Just the settings dialog's Files tab needs — no filesystem walk, tet.json alone. */
    explorerSettings(projectId: string): Promise<ExplorerSettings>;
    /** A file's content for the diff dialog's editor. */
    readFile(projectId: string, path: string): Promise<FileContent>;
    /** Writes a file's content; `expectedMtimeMs` must match what's on disk or nothing is written. */
    writeFile(projectId: string, path: string, content: string, expectedMtimeMs: number): Promise<FileWriteResult>;
    /** Fires whenever a repository's state changed (git command, file watcher or refresh). */
    onState(listener: (payload: { projectId: string; state: RepositoryState }) => void): Unsubscribe;
  };
  /** A project's saved shell commands, kept in a tet.json in its own root, so they travel with it. */
  commands: {
    list(projectId: string): Promise<ProjectCommand[]>;
    /** Writes the whole list; adding, removing and reordering all go through here. */
    save(projectId: string, commands: ProjectCommand[]): Promise<void>;
    /** Opens a terminal tab whose process is that command; null when there is nothing to run it with. */
    run(projectId: string, command: ProjectCommand): Promise<TerminalDescriptor | null>;
    /** Fires when a project's tet.json changed on disk, whoever wrote it. */
    onChanged(listener: (payload: { projectId: string }) => void): Unsubscribe;
  };
  terminals: {
    list(projectId: string): Promise<TerminalDescriptor[]>;
    /** Opens a tab for a new session of that agent; the session itself starts on first resize. */
    create(projectId: string, agentId: AgentId): Promise<TerminalDescriptor>;
    /** Closes tabs and deletes the sessions behind them. */
    close(projectId: string, tabIds: string[]): Promise<void>;
    rename(projectId: string, tabId: string, title: string): Promise<void>;
    /** Kills a saved command's process and spawns it again in the same tab. */
    restart(projectId: string, tabId: string): Promise<void>;
    /** The tab is on screen, clearing the `finishedAt` a finished turn left on it — the renderer's
     *  half of the mark, the main process not being able to tell which tab is in front. */
    seen(projectId: string, tabId: string): void;
    input(projectId: string, tabId: string, data: string): void;
    /** The first resize of a tab is what starts its process (lazy spawn). */
    resize(projectId: string, tabId: string, cols: number, rows: number): void;
    /** The full url a cut-off fragment came from; null when the agent has no answer — do not re-ask. */
    resolveUrl(projectId: string, tabId: string, fragment: string): Promise<string | null>;
    /** Fires with the full tab list of a project whenever it changed. */
    onTabs(listener: (payload: { projectId: string; tabs: TerminalDescriptor[] }) => void): Unsubscribe;
    /** One message per flush, carrying every terminal that produced something in it. */
    onOutput(listener: (batch: TerminalOutput[]) => void): Unsubscribe;
    onStatus(
      listener: (payload: { projectId: string; tabId: string; status: TerminalStatus }) => void
    ): Unsubscribe;
    /** Whether anything in the project is still starting up (a CLI booting, sessions listing). */
    onStartupProgress(listener: (payload: { projectId: string; show: boolean }) => void): Unsubscribe;
    /** A tab the control channel opened, to be brought to the front. */
    onShow(listener: (payload: { projectId: string; tabId: string }) => void): Unsubscribe;
    /** The current value of the above: a project restored at app start bootstraps before the window. */
    starting(projectId: string): Promise<boolean>;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
  };
  files: {
    /** The real path of a dropped file, or "" when the drag carries only content. */
    pathOf(file: File): string;
    /** Saves content that has no path of its own and returns the temp file's path. */
    writeTemp(name: string, dataBase64: string): Promise<string>;
    /** The clipboard's image saved to a temp file; null when the clipboard holds no image. */
    clipboardImage(): Promise<string | null>;
  };
  shell: {
    openUrl(url: string): Promise<void>;
    /** Opens a path activated in a terminal: the repository-relative path for a file inside the
     *  repository, null when it was handed to the OS instead. */
    openFile(projectId: string, path: string): Promise<string | null>;
    /** Shows a repository-relative path in the OS file manager, selected. */
    revealFile(projectId: string, path: string): Promise<void>;
    /** Hands a repository-relative path to whatever the OS opens that type with. */
    openFileExternally(projectId: string, path: string): Promise<void>;
    /** Opens the project's own folder in the OS file manager. */
    openProject(projectId: string): Promise<void>;
  };
  /** Anything transient the main process wants said — see Notice. */
  onNotice(listener: (payload: Notice) => void): Unsubscribe;
  /** The persisted theme id, read synchronously off `webPreferences.additionalArguments` before
   *  main.tsx's first line runs: an async read would leave a first frame in the wrong colors. */
  initialTheme: string;
}
