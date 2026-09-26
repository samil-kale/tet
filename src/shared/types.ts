export const AGENT_IDS = ["claude", "codex", "pi", "shell"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  /** False for the shell, whose tabs are plain terminals. */
  hasSessions: boolean;
}

/** A program tet needs, and whether the startup check found it. */
export interface Requirement {
  /** Its download name — "Git", "Claude". */
  name: string;
  /** The executable looked for, for the user to try in their own terminal. */
  command: string;
  installed: boolean;
}

/** `met` is git *and* either an agent or sbx, else the app does not open. sbx suffices: a sandboxed
 *  tab runs the agent's CLI in its container (requirements.ts). */
export interface Requirements {
  met: boolean;
  git: Requirement;
  /** One is enough. */
  agents: Requirement[];
  /** Enough without any agent installed here. */
  sbx: Requirement;
  /** git is new enough to create worktrees (worktreesSupported). */
  worktrees: boolean;
}

/** A repository TET has open. Stored in `projects.json` as `{id, path, name}`; `worktrees` is read off
 *  the disk and never stored. */
export interface Project {
  /** `tet.id` in the repository's git config (projects.ts's resolveProjectId), shared by its
   *  worktrees. */
  id: string;
  /** Absolute path of the repository. */
  path: string;
  /** The directory's base name. */
  name: string;
  /** Its linked worktrees, by branch (git.ts's readWorktrees). Those TET made carry their `key`;
   *  the others (made with `git worktree add` elsewhere, or by an older TET) are shown greyed and
   *  never opened. */
  worktrees: ProjectWorktree[];
}

/** A linked worktree of a project, as the sidebar lists it. */
export type ProjectWorktree = Pick<WorktreeInfo, "path" | "branch" | "key">;

/**
 * Where something runs: a project's repository, or one of the worktrees TET made (`worktree` its
 * key). A worktree has no id of its own — it is always this pair.
 */
export interface ProjectRef {
  projectId: string;
  worktree?: string;
}

/** A ref, the repository's without a `worktree` key at all: two refs of one repository or worktree
 *  then compare, and print, alike. */
export function projectRef(projectId: string, worktree?: string): ProjectRef {
  return worktree === undefined ? { projectId } : { projectId, worktree };
}

/**
 * The pair as one string, for what can hold only one (a map, localStorage, a sandbox's name, a
 * toast): the project id alone for the repository. Never passed on as an address. No space (a
 * project's terminals are disposed by the prefix `${key} `) and no ":" (Monaco's URI authority).
 */
export function projectRefKey(ref: ProjectRef): string {
  return ref.worktree === undefined ? ref.projectId : `${ref.projectId}-${ref.worktree}`;
}

/** The repository first, then the worktrees TET made. */
export function projectRefsOf(project: Project): ProjectRef[] {
  return [
    projectRef(project.id),
    ...project.worktrees.flatMap((worktree) => (worktree.key === undefined ? [] : [projectRef(project.id, worktree.key)]))
  ];
}

/** Two refs of one repository or worktree. */
export function sameProjectRef(a: ProjectRef, b: ProjectRef | undefined): boolean {
  return b !== undefined && projectRefKey(a) === projectRefKey(b);
}

/** The worktree of the project a ref names; undefined for the repository, and for a key the
 *  project does not list. */
export function worktreeOf(project: Project, ref: ProjectRef): ProjectWorktree | undefined {
  return ref.worktree === undefined ? undefined : project.worktrees.find((worktree) => worktree.key === ref.worktree);
}

/** What the window is told of a change to the projects (projects.ts): repositories and worktrees
 *  opened and closed, and the one the user (or tet-ctl) just opened, to bring to the front. */
export interface ProjectsChange {
  added?: ProjectRef[];
  removed?: ProjectRef[];
  show?: ProjectRef;
}

/** A worktree's name: its branch, else (detached) TET's key, else its folder's. */
export function worktreeName(worktree: ProjectWorktree): string {
  return worktree.branch ?? worktree.key ?? worktree.path.split(/[\\/]/).pop() ?? worktree.path;
}

/** What a notice or toast calls a repository or worktree: the project's name, a worktree's with
 *  it. */
export function projectRefName(project: Project, ref: ProjectRef): string {
  const worktree = worktreeOf(project, ref);
  return worktree ? `${worktreeName(worktree)} (${project.name})` : project.name;
}

/** What every agent notifies the OS about. */
export interface NotificationSettings {
  /** The agent finished responding, with nothing it started still running. */
  finished: boolean;
  /** Blocked mid-turn on a permission prompt, an elicitation, or a question. */
  needsYou: boolean;
  /** Idle waiting for the next prompt; only Claude Code raises this event. */
  idleReminder: boolean;
}

export const COLOR_SCHEMES = ["system", "light", "dark"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** What tet keeps about itself, not about a repository; written whole. */
export interface AppSettings {
  notifications: NotificationSettings;
  /** An id out of `KEYBINDING_PRESETS`. */
  editorKeybindingPreset: string;
  /** "system" follows the OS. A window's kind is fixed when it is built (`applyTheme` in
   *  src/main/main.ts). */
  colorScheme: ColorScheme;
  /** Per kind, an id out of `THEMES` of that kind; applies at once while the window is that kind. */
  darkTheme: string;
  lightTheme: string;
  /** An empty string means tet's own (`DEFAULT_PROMPTS`). */
  prompts: PromptSettings;
}

/** A question tet asks an agent in the background, in the Prompts tab's picker. */
export const PROMPT_IDS = ["commitMessage"] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

export type PromptSettings = Record<PromptId, string>;

/**
 * A settings write: the keys it names and no others. The dialog and `tet-ctl` both write single
 * settings, and neither may take back what the other set meanwhile, so the two nested objects
 * merge by their own keys too — setting one prompt leaves the rest alone.
 */
export type SettingsEdits = Partial<Omit<AppSettings, "notifications" | "prompts">> & {
  notifications?: Partial<NotificationSettings>;
  prompts?: Partial<PromptSettings>;
};

/** `edits` laid over `base`, by that rule. */
export function withSettings<T extends SettingsEdits>(base: T, edits: SettingsEdits): T {
  return {
    ...base,
    ...edits,
    ...(edits.notifications && { notifications: { ...base.notifications, ...edits.notifications } }),
    ...(edits.prompts && { prompts: { ...base.prompts, ...edits.prompts } })
  };
}

/** Agents that run in an sbx sandbox: two with Docker's built-in kit, pi through a community kit
 *  (`AgentDefinition.sandboxKit`). Not the shell. */
export const SBX_AGENT_IDS = ["claude", "codex", "pi"] as const satisfies readonly AgentId[];
export type SbxAgentId = (typeof SBX_AGENT_IDS)[number];

export function isSbxAgent(agentId: string): agentId is SbxAgentId {
  return (SBX_AGENT_IDS as readonly string[]).includes(agentId);
}

/** Forwards `host` to `container`. Strings as typed; validated only at `sbx run`. */
export interface SbxPort {
  host: string;
  container: string;
}

/** `sbx mount`'s modes (`HOST:TARGET:ro|rw`), labelled Read / Read+Write. */
export const SBX_ACCESS = ["ro", "rw"] as const;
export type SbxAccess = (typeof SBX_ACCESS)[number];

/** An "Allowed paths" row: a host folder or a single file. */
export interface SbxPath {
  path: string;
  access: SbxAccess;
}

/** Which non-identity host knowledge to mount into the sandbox, with which access; `false` is off.
 *  Agent-agnostic — the paths per agent are `AgentDefinition.sandboxKnowledge`. Kept on this
 *  machine per project, never in tet.json (sbx-local.ts): it names this machine's folders. */
export interface SbxKnowledgeConfig {
  skills: SbxAccess | false;
  plugins: SbxAccess | false;
  /** The personal instructions file — `CLAUDE.md` for Claude, `AGENTS.md` for Codex and pi. */
  instructions: SbxAccess | false;
  /** A folder every agent's skills come from instead of its own, mounted at each one's own skills
   *  folder; absent for each agent's own. */
  skillsFolder?: string;
}

/** The kinds of knowledge, each switched on with an access. */
export type SbxKnowledgeKind = Exclude<keyof SbxKnowledgeConfig, "skillsFolder">;

/** One piece of host knowledge, and where the sandboxed CLI reads it. */
export interface SbxKnowledgeEntry {
  host: string;
  /** Absolute container path, under the sandbox's home. */
  target: string;
}

/** An agent installed on this machine, and what the Knowledge tab's rows mount for it (sbx.ts's
 *  readKnowledgeSources). */
export interface SbxKnowledgeSource {
  agentId: SbxAgentId;
  displayName: string;
  /** Per kind, what exists here of the agent's own. */
  own: Record<SbxKnowledgeKind, SbxKnowledgeEntry[]>;
  /** Where a chosen `skillsFolder` goes in its sandbox. */
  skillsTargets: string[];
}

/**
 * A "Secrets" row: an sbx custom secret. The sandbox sees `env` set to a placeholder, and sbx's
 * proxy swaps it for the value in requests to `hosts` (sbx.ts's applySecrets). Never the value,
 * which stays on this machine (sbx-local.ts).
 */
export interface SbxSecret {
  env: string;
  /** Exact host, IP or wildcard (`*.example.com`) — sbx refuses a scheme or port (measured, 0.42.1). */
  hosts: string[];
}

/**
 * A "Variables" row: `env` set in the sandbox with its real value — which, unlike a secret's, the
 * sandbox sees (sbx.ts's sandboxEnv). Never the value, which stays on this machine (sbx-local.ts).
 */
export interface SbxVariable {
  env: string;
}

/** Per project, for every sandboxed tab whatever its agent. No authentication: each agent signs in
 *  inside the sandbox, pi excepted (a credential from sbx's own store, see sbx.ts). */
export interface SbxProjectConfig {
  enabled: boolean;
  ports: SbxPort[];
  paths: SbxPath[];
  /** "Allowed hosts" in sbx's grammar — exact host, wildcard (`*.example.com`), optional port.
   *  Unvalidated: sbx accepts anything (measured, 0.42.1 — `https://example.com` matches nothing). */
  hosts: string[];
  secrets: SbxSecret[];
  variables: SbxVariable[];
}

/** The two lists of the SBX Settings whose values stay on this machine (sbx-local.ts). */
export type SbxValueKind = "secrets" | "variables";

/** What the SBX Settings keep on this machine, never in tet.json (sbx-local.ts): which Secrets and
 *  Variables rows hold a value here — never a value — and the knowledge. */
export interface SbxStoredLocal extends Record<SbxValueKind, string[]> {
  knowledge: SbxKnowledgeConfig;
}

/**
 * Save's part of one list for this machine, both by the row's env name: the values typed since
 * opening, and the name each row was opened under — its stored value follows a renamed row, and a
 * row added under a stored name does not inherit that value.
 */
export interface SbxLocalEdits {
  values: Record<string, string>;
  from: Record<string, string>;
}

export interface SbxLocalSave extends Record<SbxValueKind, SbxLocalEdits> {
  knowledge: SbxKnowledgeConfig;
}

/** Every kind off, each agent's own skills: no knowledge stored for a project. */
export const EMPTY_SBX_KNOWLEDGE: SbxKnowledgeConfig = { skills: false, plugins: false, instructions: false };

/** A rule sbx's policy must allow before tet can sandbox a project (sbx.ts's readSbxBlockers). */
export interface SbxBlocker {
  /** What it is for, a word or two. */
  what: string;
  /** The rule to ask for, in sbx's own grammar. */
  allow: string;
}

/** Checked before the sbx dialog shows its fields (sbx.ts's readSbxStatus). Each field means
 *  something only when the one above is true. */
export interface SbxStatus {
  installed: boolean;
  loggedIn: boolean;
  /** sbx's own error when it failed for a reason other than being signed out (a hung daemon), or
   *  that it is older than tet drives (sbx.ts's sbxVersionSupported), with `loggedIn` false;
   *  signing in would not help. */
  failure?: string;
  policyInitialized: boolean;
  /** The organization managing the account's policies, when one does; local allow rules then do
   *  not apply. */
  organization?: string;
  /** Shown instead of the dialog's fields while non-empty. */
  blockers: SbxBlocker[];
}

/** A Docker access token kept for the SBX Settings' General tab (sbx-accounts.ts), for every
 *  project; the token itself never reaches the renderer. */
export interface SbxAccount {
  id: string;
  /** The Docker username `sbx login --username` takes with the token. */
  user: string;
}

/** One access token row at Save: `id` the account it was opened as, `token` what was typed since
 *  ("" keeps the stored one). */
export interface SbxAccountEdit {
  id?: string;
  user: string;
  token: string;
}

/** A sign-in's answer: whether sbx took the token, the account kept for it, and else why not —
 *  what sbx said on refusing, or, signed in all the same, why the token could not be kept. */
export interface SbxSignInResult {
  signedIn: boolean;
  account?: SbxAccount;
  error?: string;
}

/** What the SBX Settings apply, by the dialog tab each is on: what a problem is told under. */
export type SbxOption = "hosts" | "paths" | "knowledge" | "ports" | "secrets" | "variables";

/**
 * What of the SBX Settings cannot be applied here, per option: each row's key (the host, the path
 * as configured, the knowledge kind, `host:container`, the env name) with what is wrong with it
 * (sbx.ts's readSbxProblems). Such a row is neither saved nor applied.
 */
export type SbxProblems = Partial<Record<SbxOption, Record<string, string>>>;

/** A Save's answer: what it left out, so the caller can say it. */
export interface SbxSaveResult extends GitActionResult {
  problems?: SbxProblems;
}

/** No `sbx` section in tet.json; also the dialog's initial state. */
export const EMPTY_SBX_CONFIG: SbxProjectConfig = {
  enabled: false,
  ports: [],
  paths: [],
  hosts: [],
  secrets: [],
  variables: []
};

/** Shared so main and renderer cannot drift apart. */
export const DEFAULT_KEYBINDING_PRESET_ID = "vscode";

/** The settings dialog's Info tab, read once. */
export interface AppInfo {
  /** package.json's version. */
  version: string;
  electron: string;
  chromium: string;
  node: string;
  /** `process.platform` and `process.arch`. */
  os: string;
}

/** A value an agent suggested for a field, or why there is none — said under that field. */
export interface SuggestionResult {
  value?: string;
  error?: string;
}

/** Open/clone/create/new worktree: the project, or git's message. `worktree` names the worktree it
 *  was about, to bring to the front. */
export interface AddRepositoryResult {
  project?: Project;
  worktree?: string;
  error?: string;
  /** The clone wants a login for this url; the dialog asks for one (GitActionResult). */
  loginUrl?: string;
}

/** A username and password (or token) typed into tet for a git host. */
export interface GitLogin {
  username: string;
  password: string;
}

export type ProviderId = "github" | "gitlab";

/** A repository host account. Its token is kept encrypted, main-side. */
export interface ProviderAccount {
  id: string;
  provider: ProviderId;
  /** "github.com", or a self-hosted instance. */
  host: string;
  /** The token's login, read from the API when added. */
  user: string;
  /** The group the list was last narrowed to; "" is all, undefined never picked. */
  namespace?: string;
}

/** An environment variable tet sets in every tab it starts, a sandboxed one excepted, over the
 *  machine's own. Its value is kept main-side and reaches only a tab's environment. */
export interface EnvVarInfo {
  name: string;
  /** The environment TET was started with has it too — set on this machine (setx, a shell
   *  profile); TET's value replaces it in its tabs. */
  overridesMachine: boolean;
}

/** What TET tells the user of variables it keeps that the machine sets too — once at start, in the
 *  dialog that saved them, over their row in the Settings. */
export function overridesMachineNote(names: string[]): string {
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} set on this machine too; TET's value replaces it in the tabs it starts.`;
}

/** What `env-request` puts in front of the user: one row per variable. */
export interface EnvRequest {
  id: number;
  /** The asking tab, for the dialog to name and to restart. */
  ref?: ProjectRef;
  tabId?: string;
  /** A stored one's value the dialog replaces. */
  variables: (EnvVarInfo & { stored: boolean })[];
}

/** What the dialog answers per row, as typed; null for Cancel. */
export interface EnvAnswer {
  name: string;
  value: string;
}

/** A row of the Settings' Environment tab on Save: `from` names the stored variable it shows (so a
 *  renamed one keeps its value), `value` is what was typed — absent keeps the stored one. */
export interface EnvEdit {
  name: string;
  from?: string;
  value?: string;
}

/** A repository the remote tab lists. */
export interface RemoteRepository {
  /** "owner/name". */
  fullName: string;
  /** The clone tab's default folder name. */
  name: string;
  /** The https url; the account's token can authenticate it. */
  cloneUrl: string;
}

/** The account once its token checked out, or the API's message. */
export interface AddAccountResult {
  account?: ProviderAccount;
  error?: string;
}

export interface ListRepositoriesResult {
  repos?: RemoteRepository[];
  error?: string;
}

/** A command row's color, stored as the ANSI name so a theme change recolors the rows: the row is
 *  drawn in --vscode-terminal-ansiBright<Name>. The six hues only — black, white and the greys are
 *  the terminal's own background or foreground in one theme or another. */
export const COMMAND_COLORS = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
export type CommandColor = (typeof COMMAND_COLORS)[number];

/** A project's saved shell command. */
export interface ProjectCommand {
  command: string;
  /** The row's label; the line is what runs. */
  name?: string;
  /** What the row is drawn in; absent is the list's own foreground. See COMMAND_COLORS. */
  color?: CommandColor;
  /** Relative to the project root; absent means the root. */
  cwd?: string;
  /** Its own field because PowerShell reads `PROFILE=x java ...` as a command name. Wins over the
   *  inherited environment. */
  env?: Record<string, string>;
  /** Runs the line in a shell (pipes, redirections); then only works on the platform it was
   *  written for. */
  shell?: boolean;
}

export interface RemoteInfo {
  name: string;
  /** Branch names without the remote prefix, e.g. "development". */
  branches: string[];
  /** e.g. "git@github.com:owner/repo.git"; read when the project opens, not on every refresh. */
  url?: string;
}

export type StashCommand = "apply" | "pop" | "drop";

export interface StashEntry {
  /** e.g. "stash@{0}". Not stable: dropping one renumbers the rest. */
  ref: string;
  /** The stash's commit, which the commands take: it stays put while the refs renumber. */
  sha: string;
  /** git's line, e.g. "WIP on main: 1a2b3c the last commit's subject". */
  message: string;
}

/** A merge or rebase stopped half-way, which the UI offers to abort. */
export type GitOperation = "merge" | "rebase";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface FileChange {
  /** Repository-relative path, forward slashes. */
  path: string;
  status: ChangeStatus;
  /** Previous path, set for renames. */
  origPath?: string;
}

export interface RepositoryState {
  /** Branch name, or the short commit id while HEAD is detached. */
  head: string;
  detached: boolean;
  /** The branch's commit; absent while detached (`head` is the id then) or unborn. Tells a pull or
   *  reset apart from the branch standing still. */
  headCommit?: string;
  /** e.g. "origin/main"; absent without one. */
  upstream?: string;
  /** Relative to the upstream; both 0 without one. */
  ahead: number;
  behind: number;
  localBranches: string[];
  /** Ahead/behind of non-current branches, only where `%(upstream:trackshort)` says they differ —
   *  each count costs a `rev-list`. The current branch's are `ahead`/`behind`. */
  branchTrack: Record<string, { ahead: number; behind: number }>;
  /** Each local branch's upstream on a remote — what a push goes to and "Also delete on the
   *  remote" deletes. Absent without one. */
  branchUpstreams: Record<string, BranchUpstream>;
  /** The repository's worktrees, main first (git.ts's readWorktrees). A branch checked out in
   *  another one is shown there on a checkout, as in GitHub Desktop: git refuses it here. */
  worktrees: WorktreeInfo[];
  remotes: RemoteInfo[];
  /** What "Update from" merges and a deleted current branch gives way to, found as GitHub Desktop
   *  finds it: the local branch tracking the remote's HEAD branch, else the local branch of that
   *  name, else the remote branch. */
  defaultBranch?: CheckoutTarget;
  /** In `for-each-ref` order. */
  tags: string[];
  stashes: StashEntry[];
  changes: FileChange[];
  operation?: GitOperation;
  /** git could not run or the folder is no repository; the rest is then empty. */
  error?: string;
}

/** One worktree of a repository, read off its git directory. */
export interface WorktreeInfo {
  /** In on-disk spelling, as a project's path. */
  path: string;
  /** Its checked-out branch; absent while detached. */
  branch?: string;
  /** The branch a linked worktree's branch was made from, as tet records it (`branch.<name>.base`
   *  in the repository's config, git.ts's worktreeAdd); absent for one made elsewhere. Laid over
   *  the read by `Repository.emit`, with the remote urls, not read per refresh. */
  base?: string;
  /** The one holding the repository's `.git`, which is never renamed or deleted. */
  main: boolean;
  /** TET's key for a worktree it made (project-dirs.ts's worktreeKeyOf); absent for the main one and
   *  for one made elsewhere. Laid over the read by `Repository.emit`, like `base`. */
  key?: string;
  /** The worktree this state was read in. */
  current: boolean;
}

/** Nothing read yet. Never mutated, only spread from. */
export const EMPTY_REPOSITORY_STATE: RepositoryState = {
  head: "",
  detached: false,
  ahead: 0,
  behind: 0,
  localBranches: [],
  branchTrack: {},
  branchUpstreams: {},
  worktrees: [],
  remotes: [],
  tags: [],
  stashes: [],
  changes: []
};

/** Decides how long a notice stands (Notices.tsx). */
export type NoticeSeverity = "error" | "warning" | "info";

/** A notice the window showed, reported for `tet-ctl notices-list`. */
export interface NoticeReport extends Notice {
  /** ms since epoch. */
  at: number;
}

/** An editor tab's state, reported by the renderer (where the editor alone lives) on every
 *  snapshot change, for `tet-ctl editor-state` and `editor-list`. Without the text: up to 4 MB,
 *  and a snapshot changes several times per write on disk (measured). Which tab is active is
 *  reported apart, by the window's layout. */
export interface EditorReport {
  path: string;
  /** The read of `path` still in flight. */
  loading: boolean;
  dirty: boolean;
  readOnly: boolean;
  /** Why the file could not be read. */
  error?: string;
  /** The tab the next file opened replaces. */
  preview: boolean;
}

/** `editor-list`'s entry: the report plus whether it is the project's active editor tab. */
export interface EditorListing extends EditorReport {
  active: boolean;
}

/** Anything the user is told — not a *status*, which a view draws itself. */
export interface Notice {
  severity: NoticeSeverity;
  message: string;
}

/** The file at HEAD — the diff editor's original side. */
export interface HeadBlob {
  content: string;
  /** Binary, image or too large; `content` is empty. */
  binary: boolean;
  /** Not in HEAD (untracked, added, unborn branch); diffs as all new. */
  missing: boolean;
  /** An image's committed version as a data URL, instead of `content`. */
  image?: string;
}

/** The working tree's text plus HEAD's, read once per open. */
export interface FileContent {
  path: string;
  content: string;
  /** Checked on save so an outside edit is never clobbered. 0 for a deleted file, never saved. */
  mtimeMs: number;
  binary: boolean;
  tooLarge: boolean;
  /** An image as a data URL, instead of `content`. */
  image?: string;
  /** Absent for an unchanged file: the diff editor mirrors its own content, nothing marked. */
  head?: HeadBlob;
  /** Missing from the working tree; the editor is read-only. */
  deleted?: boolean;
  error?: string;
}

/** Written, or why not — a stale `mtimeMs` never overwrites silently. */
export interface FileWriteResult extends GitActionResult {
  mtimeMs?: number;
  /** Refused as changed on disk since `expectedMtimeMs`: its mtime now, to overwrite against once
   *  the user agreed. */
  diskMtimeMs?: number;
}

/**
 * The Explorer tree's files — a filesystem scan, not `git ls-files`, which cannot represent an empty
 * directory. `emptyDirs` holds only directories no file implies. `.git` is always left out. Carries
 * `tet.json`'s view settings too, for one read; `roots` is absent without a `folders` list. Paths
 * are repository-relative, each file listed once whatever roots contain it.
 */
export interface ExplorerListing {
  files: string[];
  emptyDirs: string[];
  roots?: ExplorerRoot[];
  compactFolders: boolean;
  sortOrder: ExplorerSortOrder;
  /** Per listed file and directory — only read for `modified`. */
  mtimes?: Record<string, number>;
}

/** A `folders` entry: a top-level tree node labelled `name`. */
export interface ExplorerRoot {
  name: string;
  /** Repository-relative, forward slashes; "" for the root. */
  path: string;
}

/** VS Code's `explorer.sortOrder`. `foldersNestsFiles` is `default` without file nesting. */
export const EXPLORER_SORT_ORDERS = ["default", "mixed", "filesFirst", "type", "modified", "foldersNestsFiles"] as const;
export type ExplorerSortOrder = (typeof EXPLORER_SORT_ORDERS)[number];

/** What the settings dialog's Files tab edits, read on its own. */
export interface ExplorerSettings {
  /** `explorer.excludeGitIgnore`: hide what git ignores too. */
  excludeGitIgnore: boolean;
  /** `explorer.compactFolders`: fold `src/main/java` into one row. */
  compactFolders: boolean;
  /** `explorer.sortOrder`. */
  sortOrder: ExplorerSortOrder;
}

/**
 * What the SEARCH pane's field asks for: VS Code's search box with its three toggles, over the
 * files' lines (`Repository.searchFiles`). The Explorer's own field filters the tree by name and
 * asks for nothing here.
 */
export interface FileSearchQuery {
  /** What was typed; a regex when `regex` is on. */
  text: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One match, not one line: two matches in a line are two rows, as VS Code lists them. */
export interface FileSearchMatch {
  /** 1-based, as the editor counts. */
  line: number;
  /** 1-based, in the line — where the editor puts the selection. */
  column: number;
  length: number;
  /** The row's text: the line without its indent, cut to a window that holds the match. */
  text: string;
  /** Where the match starts inside `text`, 0-based. */
  textColumn: number;
}

export interface FileSearchFile {
  path: string;
  matches: FileSearchMatch[];
}

/** `Repository.searchFiles`'s answer, files in path order. */
export interface FileSearchResult {
  files: FileSearchFile[];
  /** The match cap was reached: what is listed is a part of what is there. */
  truncated: boolean;
  /** An invalid regex; nothing was searched. */
  error?: string;
}

export interface GitActionResult {
  ok: boolean;
  error?: string;
  /** git wanted credentials; set only by network commands (git.ts's runNetwork). */
  authRequired?: boolean;
  /** The http(s) remote that wants a login, set by main from `authRequired`: the view that
   *  offered the action asks for one and runs it again with it. Never for an ssh remote or a local
   *  path, where there is nothing to type. */
  loginUrl?: string;
  /**
   * Nothing was done: the command waits on a question. Which one is the reason named here, and
   * the view that offered the action puts it in its own words and runs the action again
   * confirmed (AGENTS.md: main asks nothing). One field, so a new question is a new reason and
   * not another flag every other caller has to ignore.
   *
   * - `trash-failed`: a discard could not move a file to the trash; nothing was reset. Confirmed,
   *   it deletes.
   * - `rewrites-pushed`: a rebase would rewrite commits already on the upstream.
   * - `uncommitted`: a worktree has changes, so neither it nor its terminals were touched.
   */
  needsConfirmation?: "trash-failed" | "rewrites-pushed" | "uncommitted";
}

/** A local branch, or a remote-tracking one like "origin/development". */
export interface CheckoutTarget {
  name: string;
  remote?: string;
}

/** One terminal's output since the last flush. Batched, so the message count does not grow with
 *  the number of open terminals. */
export interface TerminalOutput {
  ref: ProjectRef;
  tabId: string;
  data: string;
}

export const TERMINAL_STATUSES = ["missing", "ready", "running", "stopped", "error"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface TerminalDescriptor {
  /** Unique within its repository or worktree; equals the agent's session id for a restored tab. */
  tabId: string;
  agentId: AgentId;
  /** Session title; "" makes the UI show a placeholder. */
  title: string;
  status: TerminalStatus;
  /** The agent's session id; absent until the CLI persisted one. Equals `tabId` for a restored tab,
   *  hence the split layout's key. */
  sessionId?: string;
  /** Last activity, ms since epoch; absent without a session. */
  updatedAt?: number;
  /** ms since epoch; absent without a session. */
  createdAt?: number;
  /** Last turn finished unseen, ms since epoch; cleared once on screen (`terminals.seen`). A time,
   *  not a flag: the project row's mark opens the oldest first. */
  finishedAt?: number;
  /** Working a turn — reported by the agent at both ends, never read off the TUI. False once the
   *  process has ended. */
  busy?: boolean;
  /** This tab's pane shows the progress bar: runtime being prepared, or CLI before its first frame.
   *  Read off the session manager's per-tab indicator count at each snapshot. */
  starting?: boolean;
  /** Stopped mid-turn on an unanswered question, ms since epoch. Cleared like `finishedAt` and by
   *  either end of a turn. Not a shade of `busy`: such a session is *not* working. */
  waitingAt?: number;
  /** A saved command's tab; only these offer Restart. */
  savedCommand?: boolean;
  /** The saved command's line from `tet.json` — the split layout's `commandPane` key, so the next
   *  run lands where the last lay. The line, since `name` may be missing. */
  command?: string;
}

/** Why a worktree cannot be created with an older git (worktreesSupported). */
export const WORKTREES_NEED_GIT = "needs git 2.48 or newer";

/**
 * Whether `git --version`'s answer has `worktree add --relative-paths` (2.48), which tet's worktrees
 * are made with (git.ts's worktreeAdd). Renaming (the branch alone) and deleting need nothing new.
 */
export function worktreesSupported(version: string | undefined): boolean {
  const [major = 0, minor = 0] = (version ?? "").split(".").map((part) => parseInt(part, 10) || 0);
  return major > 2 || (major === 2 && minor >= 48);
}

/**
 * Where a new worktree's branch starts: the default branch, else — a repository with no remote HEAD
 * and no local branch named as `init.defaultBranch` has none — what the repository has checked
 * out. Undefined only while that is detached or unborn.
 */
export function worktreeBase(state: RepositoryState): CheckoutTarget | undefined {
  if (state.defaultBranch) {
    return state.defaultBranch;
  }
  const main = state.worktrees.find((worktree) => worktree.main)?.branch;
  return main === undefined ? undefined : { name: main };
}

/** The remote a command uses where no branch names one (tags, publishing a branch): the first,
 *  which `Repository.emit` makes "origin" where there is one. */
export function defaultRemote(state: RepositoryState): string | undefined {
  return state.remotes[0]?.name;
}

/** The remote a fetch, pull or push of the checked-out branch reaches: its upstream's, else
 *  `defaultRemote`. */
export function headRemote(state: RepositoryState): string | undefined {
  return state.branchUpstreams[state.head]?.remote ?? defaultRemote(state);
}

/** `headRemote`, and whether fetch, pull and push can go: not without a remote, nor from a
 *  detached HEAD. */
export function syncRemote(state: RepositoryState): { remote: string | undefined; canSync: boolean } {
  const remote = headRemote(state);
  return { remote, canSync: remote !== undefined && !state.detached };
}

/** The ref git and the UI name a target by: `remote/name` for a remote branch. */
export function refName(target: CheckoutTarget): string {
  return target.remote ? `${target.remote}/${target.name}` : target.name;
}

/** A local branch's upstream on a remote, e.g. `{ remote: "origin", branch: "main" }`. */
export interface BranchUpstream {
  remote: string;
  branch: string;
}

/** The upstream as git names it and a message shows it: "origin/main". */
export function upstreamName(upstream: BranchUpstream): string {
  return refName({ name: upstream.branch, remote: upstream.remote });
}

/** As every spinner shows it: never while waiting on a question, whatever `busy` says. */
export function isWorking(tab: TerminalDescriptor): boolean {
  return tab.busy === true && tab.waitingAt === undefined;
}
