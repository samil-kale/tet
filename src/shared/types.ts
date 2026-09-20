export type AgentId = "claude" | "opencode" | "codex" | "pi" | "shell";

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  /** False for the shell, whose tabs are plain terminals. */
  hasSessions: boolean;
  /* Mirrors of the measured AgentDefinition fields, for the renderer, which cannot import
     src/main/agents. */
  takesRightMouse: boolean;
  swapsBlueMagenta: boolean;
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
  /** git is new enough to create and rename worktrees (worktreesSupported). */
  worktrees: boolean;
}

export interface Project {
  id: string;
  /** Absolute path of the working directory. */
  path: string;
  /** The directory's base name. */
  name: string;
  /** For a linked worktree, its main worktree's path — read off the disk when the project is
   *  loaded or added, never trusted from `projects.json`. The sidebar indents it there. */
  mainPath?: string;
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

/** A question tet asks an agent in the background. */
export type PromptId = "commitMessage";

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

/** Agents that run in an sbx sandbox: three with Docker's built-in kit, pi through a community kit
 *  (`AgentDefinition.sandboxKit`). Not the shell. */
export type SbxAgentId = "claude" | "codex" | "opencode" | "pi";

export const SBX_AGENT_IDS: readonly SbxAgentId[] = ["claude", "codex", "opencode", "pi"];

export function isSbxAgent(agentId: string): agentId is SbxAgentId {
  return (SBX_AGENT_IDS as readonly string[]).includes(agentId);
}

/** Forwards `host` to `container`. Strings as typed; validated only at `sbx run`. */
export interface SbxPort {
  host: string;
  container: string;
}

/** `sbx mount`'s modes (`HOST:TARGET:ro|rw`), labelled Read / Read+Write. */
export type SbxAccess = "ro" | "rw";

/** An "Allowed paths" row: a host folder or a single file. */
export interface SbxPath {
  path: string;
  access: SbxAccess;
}

/** Which non-identity host knowledge to mount into the sandbox, with which access; `false` is off.
 *  Agent-agnostic — the paths per agent are `AgentDefinition.sandboxKnowledge`. */
export interface SbxKnowledgeConfig {
  skills: SbxAccess | false;
  plugins: SbxAccess | false;
  /** The personal instructions file — `CLAUDE.md` for Claude, `AGENTS.md` for Codex and pi. */
  instructions: SbxAccess | false;
}

/**
 * A "Secrets" row: an sbx custom secret. The sandbox sees `env` set to a placeholder, and sbx's
 * proxy swaps it for the value in requests to `hosts` (sbx.ts's applySecrets). Never the value,
 * which stays on this machine (sbx-secrets.ts).
 */
export interface SbxSecret {
  env: string;
  /** Exact host, IP or wildcard (`*.example.com`) — sbx refuses a scheme or port (measured, 0.42.1). */
  hosts: string[];
}

/** Per project, for every sandboxed tab whatever its agent. No authentication: each agent signs in
 *  inside the sandbox, pi excepted (a credential from sbx's own store, see sbx.ts). */
export interface SbxProjectConfig {
  enabled: boolean;
  knowledge: SbxKnowledgeConfig;
  ports: SbxPort[];
  paths: SbxPath[];
  /** "Allowed hosts" in sbx's grammar — exact host, wildcard (`*.example.com`), optional port.
   *  Unvalidated: sbx accepts anything (measured, 0.42.1 — `https://example.com` matches nothing).
   *  The sandbox, not tet.json, is the truth here (sbx.ts's readLiveSbxConfig). */
  hosts: string[];
  secrets: SbxSecret[];
}

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
  /** sbx's own error when it failed for a reason other than being signed out (a hung daemon),
   *  with `loggedIn` false; signing in would not help. */
  failure?: string;
  policyInitialized: boolean;
  /** The organization managing the account's policies, when one does; local allow rules then do
   *  not apply. */
  organization?: string;
  /** Shown instead of the dialog's fields while non-empty. */
  blockers: SbxBlocker[];
}

/** No `sbx` section in tet.json; also the dialog's initial state. */
export const EMPTY_SBX_CONFIG: SbxProjectConfig = {
  enabled: false,
  knowledge: { skills: false, plugins: false, instructions: false },
  ports: [],
  paths: [],
  hosts: [],
  secrets: []
};

/** The Prompts tab's picker. */
export const PROMPT_IDS: PromptId[] = ["commitMessage"];

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

/** Clone/create: the opened project, or git's message. */
export interface AddRepositoryResult {
  project?: Project;
  error?: string;
  /** The clone wants credentials; the dialog asks for them. */
  authRequired?: boolean;
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
export interface NoticeReport {
  severity: NoticeSeverity;
  message: string;
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
export interface FileWriteResult {
  ok: boolean;
  mtimeMs?: number;
  error?: string;
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
export type ExplorerSortOrder = "default" | "mixed" | "filesFirst" | "type" | "modified" | "foldersNestsFiles";

/** What the settings dialog's Files tab edits, read on its own. */
export interface ExplorerSettings {
  excludeGitIgnore: boolean;
  compactFolders: boolean;
  sortOrder: ExplorerSortOrder;
}

/**
 * What the SEARCH pane's field asks for: VS Code's search box with its three toggles, over the
 * files' lines (`searchPattern`, `Repository.searchFiles`). The Explorer's own field filters the
 * tree by name and asks for nothing here.
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

/**
 * The query as a regex, `flags` on top of the case flag — "g" for the search, which walks a line's
 * matches. Throws on an invalid regex, which the SEARCH pane reports.
 */
export function searchPattern(query: FileSearchQuery, flags: string): RegExp {
  const escaped = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // As ripgrep's `-w`, which VS Code searches with: the whole expression between word boundaries.
  const source = query.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
  return new RegExp(source, query.matchCase ? flags : `${flags}i`);
}

export interface GitActionResult {
  ok: boolean;
  error?: string;
  /** git wanted credentials; set only by network commands, acted on only by the clone. */
  authRequired?: boolean;
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

/** A worktree an action names: its folder, and the main worktree its git commands run in. */
export interface WorktreeRef {
  path: string;
  mainPath: string;
}

/** A local branch, or a remote-tracking one like "origin/development". */
export interface CheckoutTarget {
  name: string;
  remote?: string;
}

/** One terminal's output since the last flush. Batched, so the message count does not grow with
 *  the number of open terminals. */
export interface TerminalOutput {
  projectId: string;
  tabId: string;
  data: string;
}

export const TERMINAL_STATUSES = ["missing", "ready", "running", "stopped", "error"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface TerminalDescriptor {
  /** Unique within its project; equals the agent's session id for a restored tab. */
  tabId: string;
  projectId: string;
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

/** Why a worktree cannot be created or renamed with an older git (worktreesSupported). */
export const WORKTREES_NEED_GIT = "needs git 2.48 or newer";

/**
 * Whether `git --version`'s answer has `worktree add` and `move` with `--relative-paths` (2.48),
 * which tet's worktrees are made with (git.ts's worktreeAdd). Deleting one needs neither.
 */
export function worktreesSupported(version: string | undefined): boolean {
  const [major = 0, minor = 0] = (version ?? "").split(".").map((part) => parseInt(part, 10) || 0);
  return major > 2 || (major === 2 && minor >= 48);
}

/**
 * Where a new worktree's branch starts: the default branch, else — a repository with no remote HEAD
 * and no local branch named as `init.defaultBranch` has none — what the main worktree has checked
 * out. Undefined only while that is detached or unborn.
 */
export function worktreeBase(state: RepositoryState): CheckoutTarget | undefined {
  if (state.defaultBranch) {
    return state.defaultBranch;
  }
  const main = state.worktrees.find((worktree) => worktree.main)?.branch;
  return main === undefined ? undefined : { name: main };
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
  return `${upstream.remote}/${upstream.branch}`;
}

/** As every spinner shows it: never while waiting on a question, whatever `busy` says. */
export function isWorking(tab: TerminalDescriptor): boolean {
  return tab.busy === true && tab.waitingAt === undefined;
}
