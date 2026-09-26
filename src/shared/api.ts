import type {
  AddAccountResult,
  AddRepositoryResult,
  AgentId,
  AgentInfo,
  AppInfo,
  AppSettings,
  ProjectRef,
  CheckoutTarget,
  EditorReport,
  EnvAnswer,
  EnvEdit,
  EnvRequest,
  EnvVarInfo,
  ExplorerListing,
  ExplorerSettings,
  FileContent,
  FileSearchQuery,
  FileSearchResult,
  FileWriteResult,
  GitActionResult,
  GitLogin,
  ListRepositoriesResult,
  Notice,
  NoticeReport,
  Project,
  ProjectCommand,
  ProjectsChange,
  ProviderAccount,
  ProviderId,
  RepositoryState,
  Requirements,
  SbxAccount,
  SbxAccountEdit,
  SbxKnowledgeConfig,
  SbxKnowledgeSource,
  SbxLocalSave,
  SbxProblems,
  SbxProjectConfig,
  SbxSaveResult,
  SbxSignInResult,
  SbxStatus,
  SbxStoredLocal,
  SbxValueKind,
  SettingsEdits,
  StashCommand,
  SuggestionResult,
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
    /** Ends every session and starts tet again, as `tet-ctl restart-app` does. */
    restart(): void;
  };
  /** Docker Sandboxes, opt-in per project through the project row's "SBX Settings". */
  sbx: {
    /** All the dialog checks before showing its fields. Never cached, PATH re-read first — "Check
     *  again" follows an install. Per project: the policy must allow the project's folder. */
    status(projectId: string): Promise<SbxStatus>;
    /** Opens the OAuth page in the browser and waits; no terminal. */
    login(): Promise<boolean>;
    /** Who sbx says is signed in; only once `status` said someone is. */
    signedInUser(): Promise<string | undefined>;
    /** The access tokens kept for every project — never a token. */
    accounts(): Promise<SbxAccount[]>;
    /** `sbx login` with `token`, or with the one kept for `accountId` when `token` is ""; the
     *  account is kept (or its token replaced) only once sbx took it. */
    signIn(user: string, token: string, accountId?: string): Promise<SbxSignInResult>;
    /** `sbx logout`, which stops every running sandbox; what sbx said on failing. */
    logout(): Promise<string | undefined>;
    /** The General tab's access token rows at Save; what refused them, else undefined. */
    saveAccounts(edits: SbxAccountEdit[]): Promise<string | undefined>;
    /** Sets the machine-wide network policy to "balanced", Docker's recommended default. */
    initPolicy(): Promise<boolean>;
    /** Kills a running `login`/`signedInUser`/`signIn`/`initPolicy` — the Cancel button. */
    cancelSetup(): void;
    /** From tet.json. */
    getConfig(projectId: string): Promise<SbxProjectConfig>;
    /** What the dialog keeps on this machine — never a value. */
    stored(projectId: string): Promise<SbxStoredLocal>;
    /** The agents installed here and what each brings of its own knowledge. */
    knowledgeSources(): Promise<SbxKnowledgeSource[]>;
    /** Stores `local` (the values typed at this Save, the knowledge) on this machine, then saves
     *  and applies the rows without a problem (sbx-settings.ts's saveProjectSbx); a sandbox whose
     *  folders changed is removed. */
    saveConfig(projectId: string, request: SbxProjectConfig, local: SbxLocalSave): Promise<SbxSaveResult>;
    /** What of the rows cannot be applied here, for their marks; `values` the env names that hold
     *  a value, as the rows have them. */
    problems(
      projectId: string,
      config: SbxProjectConfig,
      knowledge: SbxKnowledgeConfig,
      values: Record<SbxValueKind, string[]>
    ): Promise<SbxProblems>;
  };
  /** One set for the whole app. */
  settings: {
    get(): Promise<AppSettings>;
    /** Writes the named keys and leaves the rest as stored (settings.ts's patch). A switch applies
     *  to agents set up after it. */
    patch(edits: SettingsEdits): Promise<void>;
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
    /** `git clone` into `directory`/`name`; an account's token authenticates it, else `login`
     *  where the first try answered `loginUrl`. */
    clone(
      url: string,
      directory: string,
      name: string,
      accountId?: string,
      login?: GitLogin
    ): Promise<AddRepositoryResult>;
    /** `git init` of `directory`/`name`, opened as a project. */
    create(directory: string, name: string): Promise<AddRepositoryResult>;
    /** Deletes the worktrees TET made with their branches, then TET's data of the project and its
     *  `tet.id`; the repository's folder stays. The caller confirms first when it has worktrees. */
    remove(projectId: string): Promise<GitActionResult>;
    /** A worktree under `~/.tet/projects/<id>/worktrees` with a new branch of its own, `branch` at the
     *  default branch (`worktreeBase`), opened with its project. Worktree and branch are one: deleting
     *  either does both, renaming the branch renames the worktree. Announced as `onChanged`. */
    addWorktree(projectId: string, branch: string): Promise<AddRepositoryResult>;
    /** Unless `force`, answers `uncommitted` for a worktree with changes, closing nothing; else closes
     *  it and deletes its folder, then its branch — with `onRemote` the branch's upstream too. */
    deleteWorktree(worktree: ProjectRef, options: { force: boolean; onRemote: boolean }): Promise<GitActionResult>;
    /** The full dragged order of ids. */
    reorder(projectIds: string[]): Promise<void>;
    /** A project or worktree was opened or closed, or a worktree's branch changed. `show` is what the
     *  user (or tet-ctl) just opened, to bring to the front. */
    onChanged(listener: (payload: ProjectsChange & { projects: Project[] }) => void): Unsubscribe;
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
  environment: {
    /** Never the values. */
    list(): Promise<EnvVarInfo[]>;
    /** The Settings' Environment tab, whole: why it could not be saved, else nothing. */
    save(rows: EnvEdit[]): Promise<string | undefined>;
    /** The dialog's Save (a row per variable) or Cancel (null): why it could not be saved, else nothing. */
    answer(id: number, answer: EnvAnswer[] | null): Promise<string | undefined>;
    /** An agent asked through `tet-ctl env-request`; one at a time. */
    onRequest(listener: (request: EnvRequest) => void): Unsubscribe;
    /** The asking agent is gone: the dialog of that request closes. */
    onWithdrawn(listener: (id: number) => void): Unsubscribe;
  };
  repository: {
    state(ref: ProjectRef): Promise<RepositoryState>;
    /** Schedules a refresh, for changes the watcher may have missed; the state arrives as a push. */
    refresh(ref: ProjectRef): Promise<void>;
    checkout(ref: ProjectRef, target: CheckoutTarget): Promise<GitActionResult>;
    /** `git fetch --prune`. Also runs quietly every ten minutes. Each command reaching a remote
     *  takes the `login` typed after it answered `loginUrl`. */
    fetch(ref: ProjectRef, login?: GitLogin): Promise<GitActionResult>;
    pull(ref: ProjectRef, login?: GitLogin): Promise<GitActionResult>;
    /** Sets the upstream when there is none ("publish"). */
    push(ref: ProjectRef, login?: GitLogin): Promise<GitActionResult>;
    /** The new url shows in the next state. */
    setRemoteUrl(ref: ProjectRef, remote: string, url: string): Promise<GitActionResult>;
    /** Creates the branch off `startPoint` and switches to it. */
    createBranch(ref: ProjectRef, name: string, startPoint: string): Promise<GitActionResult>;
    renameBranch(ref: ProjectRef, from: string, to: string): Promise<GitActionResult>;
    /** The caller confirms first. The checked-out branch gives way to the default branch; `onRemote`
     *  deletes its upstream. */
    deleteBranch(ref: ProjectRef, name: string, onRemote: boolean): Promise<GitActionResult>;
    /** A branch on a remote alone. The caller confirms first. */
    deleteRemoteBranch(ref: ProjectRef, remote: string, name: string, login?: GitLogin): Promise<GitActionResult>;
    /** Into the current branch. A conflict is reported and left in the tree. */
    merge(ref: ProjectRef, gitRef: string): Promise<GitActionResult>;
    /** Unless `confirmed`, answers `rewrites-pushed` instead where commits on the upstream would be
     *  rewritten; the caller asks and calls again. */
    rebase(ref: ProjectRef, gitRef: string, confirmed: boolean): Promise<GitActionResult>;
    /** Aborts `RepositoryState.operation`. */
    abort(ref: ProjectRef): Promise<GitActionResult>;
    /** Always annotated, as in GitHub Desktop. */
    createTag(ref: ProjectRef, name: string, target: string, message: string): Promise<GitActionResult>;
    pushTag(ref: ProjectRef, name: string, login?: GitLogin): Promise<GitActionResult>;
    deleteTag(ref: ProjectRef, name: string, onRemote: boolean): Promise<GitActionResult>;
    /** The tag on the remote alone: a `deleteTag` whose remote half wanted a login, again. */
    deleteRemoteTag(ref: ProjectRef, name: string, login?: GitLogin): Promise<GitActionResult>;
    /** Leaves HEAD detached. */
    checkoutTag(ref: ProjectRef, name: string): Promise<GitActionResult>;
    /** Everything the changes list shows, untracked included. */
    commitAll(ref: ProjectRef, message: string): Promise<GitActionResult>;
    /** These files alone, untracked included; nothing else staged goes with them. */
    commitPaths(ref: ProjectRef, message: string, paths: string[]): Promise<GitActionResult>;
    /** An installed agent suggests one subject for all changes, or only `paths`. */
    suggestCommitMessage(ref: ProjectRef, paths?: string[]): Promise<SuggestionResult>;
    /** Everything the changes list shows, untracked included. */
    stashPush(ref: ProjectRef, message: string): Promise<GitActionResult>;
    /** By `StashEntry.sha`, looked up when it runs. */
    stash(ref: ProjectRef, command: StashCommand, sha: string): Promise<GitActionResult>;
    /** The caller confirms first. Files go to the trash; where that fails the answer is `trash-failed`,
     *  and `permanently` deletes them instead. */
    discard(ref: ProjectRef, paths: string[], permanently: boolean): Promise<GitActionResult>;
    /** Appends the file, or its extension, to .gitignore. */
    ignore(ref: ProjectRef, path: string, scope: "file" | "extension"): Promise<GitActionResult>;
    /** With parent directories — the Explorer's "New File...". */
    createFile(ref: ProjectRef, path: string): Promise<GitActionResult>;
    /** The Explorer's "New Folder...". */
    createDirectory(ref: ProjectRef, path: string): Promise<GitActionResult>;
    /** To the trash — the Explorer's "Delete...". */
    deletePath(ref: ProjectRef, path: string): Promise<GitActionResult>;
    /** The Explorer's "Rename...". */
    renamePath(ref: ProjectRef, from: string, to: string): Promise<GitActionResult>;
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
    listExplorer(ref: ProjectRef): Promise<ExplorerListing>;
    /** The Explorer search field's matches, in the files the tree lists minus what git ignores. */
    searchFiles(ref: ProjectRef, query: FileSearchQuery): Promise<FileSearchResult>;
    /** tet.json alone, no filesystem walk. */
    explorerSettings(projectId: string): Promise<ExplorerSettings>;
    readFile(ref: ProjectRef, path: string): Promise<FileContent>;
    /** Nothing is written unless `expectedMtimeMs` matches the disk. */
    writeFile(ref: ProjectRef, path: string, content: string, expectedMtimeMs: number): Promise<FileWriteResult>;
    /** Git command, file watcher or refresh. */
    onState(listener: (payload: { ref: ProjectRef; state: RepositoryState }) => void): Unsubscribe;
    /** A working-tree entry appeared or vanished — ignored ones included, which no state reports. */
    onFilesChanged(listener: (payload: { ref: ProjectRef }) => void): Unsubscribe;
    /** The editor tabs' files, for `onFileChanged`; the whole set each time. */
    watchFiles(ref: ProjectRef, paths: string[]): Promise<void>;
    /** A `watchFiles` file was written, by anyone. */
    onFileChanged(listener: (payload: { ref: ProjectRef; path: string }) => void): Unsubscribe;
    /** For `tet-ctl editor-state` and `editor-list`; null once the tab is closed. */
    reportEditor(ref: ProjectRef, tabId: string, report: EditorReport | null): void;
    /** The project's active editor tab, which `editor-state` answers for — the window's layout knows. */
    reportActiveEditor(ref: ProjectRef, tabId: string): void;
    /** `tet-ctl editor-state` asks for the active editor tab's text; the listener answers. */
    onEditorContentRequest(listener: (ref: ProjectRef) => string | undefined): Unsubscribe;
    /** `tet-ctl editor-open`: in the preview tab, or kept with `--keep`. */
    onOpenEditor(listener: (payload: { ref: ProjectRef; path: string; keep: boolean }) => void): Unsubscribe;
  };
  /** Saved shell commands, in the project root's tet.json so they travel with it. */
  commands: {
    list(projectId: string): Promise<ProjectCommand[]>;
    /** The whole list; add, remove and reorder all go through here. Answers what refused it, for
     *  the question that is still up to show it at its field. */
    save(projectId: string, commands: ProjectCommand[]): Promise<GitActionResult>;
    /** A tab whose process is the command; null when nothing can run it. */
    run(ref: ProjectRef, command: ProjectCommand): Promise<TerminalDescriptor | null>;
    /** tet.json changed on disk, whoever wrote it. */
    onChanged(listener: (payload: { projectId: string }) => void): Unsubscribe;
  };
  terminals: {
    list(ref: ProjectRef): Promise<TerminalDescriptor[]>;
    /** The session starts on first resize. */
    create(ref: ProjectRef, agentId: AgentId): Promise<TerminalDescriptor>;
    /** Also deletes the sessions behind them. */
    close(ref: ProjectRef, tabIds: string[]): Promise<void>;
    /** Answers what the agent refused, for the question still up to show it at its field. */
    rename(ref: ProjectRef, tabId: string, title: string): Promise<GitActionResult>;
    /** Respawns a saved command in the same tab. */
    restart(ref: ProjectRef, tabId: string): Promise<void>;
    /** Clears `finishedAt` — only the renderer knows which tab is in front. */
    seen(ref: ProjectRef, tabId: string): void;
    /** The shown project's tabs in front of the user (on screen, focused window, no dialog); a turn
     *  there raises no toast. Sent whenever the set changes. */
    inFront(ref: ProjectRef | null, tabIds: string[]): void;
    input(ref: ProjectRef, tabId: string, data: string): void;
    /** The first resize starts the process (lazy spawn). */
    resize(ref: ProjectRef, tabId: string, cols: number, rows: number): void;
    /** The project's full tab list on every change. */
    onTabs(listener: (payload: { ref: ProjectRef; tabs: TerminalDescriptor[] }) => void): Unsubscribe;
    /** One message per flush for all terminals. */
    onOutput(listener: (batch: TerminalOutput[]) => void): Unsubscribe;
    onStatus(
      listener: (payload: { ref: ProjectRef; tabId: string; status: TerminalStatus }) => void
    ): Unsubscribe;
    /** Anything in the project still starting (a CLI booting, sessions listing). */
    onStartupProgress(listener: (payload: { ref: ProjectRef; show: boolean }) => void): Unsubscribe;
    /** A tab the control channel opened, to bring to front. */
    onShow(listener: (payload: { ref: ProjectRef; tabId: string }) => void): Unsubscribe;
    /** onStartupProgress's current value: a project restored at start bootstraps before the window. */
    starting(ref: ProjectRef): Promise<boolean>;
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
    /** A Markdown preview's https image as a data URL; null when it is none or too large. */
    fetchImage(url: string): Promise<string | null>;
    /** A path activated in a terminal: the repository-relative path for a file inside the
     *  repository, null when handed to the OS. */
    openFile(ref: ProjectRef, path: string): Promise<string | null>;
    /** Selected in the OS file manager. */
    revealFile(ref: ProjectRef, path: string): Promise<void>;
    /** With the OS's default app for the type. */
    openFileExternally(ref: ProjectRef, path: string): Promise<void>;
    /** In the OS file manager. */
    openProject(ref: ProjectRef): Promise<void>;
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

/** main.ts's createWindow hands `initialTheme` and `waylandSession` to the preload through
 *  `webPreferences.additionalArguments`: the theme as `theme` + its id, the flag bare. */
export const WINDOW_ARGS = { theme: "--tet-theme=", wayland: "--tet-wayland" } as const;
