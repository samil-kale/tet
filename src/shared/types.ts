export type AgentId = "claude" | "opencode" | "codex" | "pi" | "shell";

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  /** Whether this agent persists sessions; the shell does not, so its tabs are just terminals. */
  hasSessions: boolean;
  /* The three below mirror their measured AgentDefinition fields; the renderer acts on them but
     cannot import src/main/agents, so the facts travel here as data. */
  plainCtrlCKills: boolean;
  takesRightMouse: boolean;
  swapsBlueMagenta: boolean;
}

/** One program tet needs on the machine, and whether the startup check found it. */
export interface Requirement {
  /** What it is called where it is downloaded — "Git", "Claude". */
  name: string;
  /** The executable that was looked for, so the user can try it in their own terminal. */
  command: string;
  installed: boolean;
  /** Where to get it; the dialog links there, since tet installs nothing itself. */
  url: string;
}

/** What the startup check found; `met` is git *and* at least one agent, or the app does not open. */
export interface Requirements {
  met: boolean;
  git: Requirement;
  /** The agents that have to be installed; one of them is enough. */
  agents: Requirement[];
}

export interface Project {
  id: string;
  /** Absolute path of the repository working directory. */
  path: string;
  /** Display name; the directory's base name. */
  name: string;
}

/** What every agent notifies the OS about. */
export interface NotificationSettings {
  /** The agent finished responding, with nothing it started still running. */
  finished: boolean;
  /** The agent is blocked mid-turn on a permission prompt, an elicitation, or a question. */
  needsYou: boolean;
  /** Idle waiting for the next prompt; only Claude Code raises an event, the others ignore it. */
  idleReminder: boolean;
}

/** Everything tet keeps about itself rather than about one repository; written whole. */
export interface AppSettings {
  notifications: NotificationSettings;
  /** The Files tab's keybinding preset; an id out of `KEYBINDING_PRESETS`. */
  editorKeybindingPreset: string;
  /** The Appearance tab's color theme: an id out of `THEMES` or `SYSTEM_THEME_ID`, the default.
   *  Applies to windows opened after it — see `currentTheme` in src/main/theme.ts. */
  theme: string;
  /** The Prompts tab's background question; an empty string means tet's own (`DEFAULT_PROMPTS`). */
  prompts: PromptSettings;
}

/** The question tet asks an agent in the background. */
export type PromptId = "commitMessage";

export type PromptSettings = Record<PromptId, string>;

/** The agents that run in an sbx sandbox: the three Docker ships a built-in kit for, plus pi through
 *  the community kit (see sbx.ts's `SBX_CREATE_TARGET`). The shell is what stays out. */
export type SbxAgentId = "claude" | "codex" | "opencode" | "pi";

/** The same four as a list, for everything that walks them — sbx.ts's save path, the dialog's text. */
export const SBX_AGENT_IDS: readonly SbxAgentId[] = ["claude", "codex", "opencode", "pi"];

export function isSbxAgent(agentId: string): agentId is SbxAgentId {
  return (SBX_AGENT_IDS as readonly string[]).includes(agentId);
}

/** One port row: forwards `host` on the machine to `container`. Both stay strings — typed input,
 *  validated only at `sbx run` time. */
export interface SbxPort {
  host: string;
  container: string;
}

/** One allowed-path row's access — `sbx mount`'s own two modes (`HOST:TARGET:ro|rw`); the dialog
 *  labels them Read / Read+Write. */
export type SbxAccess = "ro" | "rw";

/** One row of "Allowed paths": a host folder *or* a single file — sbx mounts either. */
export interface SbxPath {
  path: string;
  access: SbxAccess;
}

/** Which of an agent's shareable, non-identity host knowledge to bring into its sandbox, and with
 *  which access — see sbx.ts's knowledgePaths for the paths per agent. `false` is off. One switch
 *  per kind, agent-agnostic: each agent's actual paths are sbx.ts's concern, not the dialog's. */
export interface SbxKnowledgeConfig {
  skills: SbxAccess | false;
  plugins: SbxAccess | false;
  /** The personal instructions file — `CLAUDE.md` for Claude, `AGENTS.md` for Codex and pi. */
  instructions: SbxAccess | false;
}

/** The sbx-settings dialog's saved state, per project: one set of ports, paths and knowledge for
 *  every sandboxed tab, whichever agent it runs. Authentication is never part of it — each agent
 *  signs in inside the sandbox, pi excepted (a credential from sbx's own store, see sbx.ts). */
export interface SbxProjectConfig {
  enabled: boolean;
  knowledge: SbxKnowledgeConfig;
  ports: SbxPort[];
  paths: SbxPath[];
  /** "Allowed hosts": the project's additions to sbx's network policy, in sbx's own grammar — an
   *  exact host, a wildcard (`*.example.com`), an optional port. Never checked: sbx validates
   *  nothing here (measured, 0.42.1 — `https://example.com` is accepted and matches no request),
   *  so a typo is a rule that never matches. The sandbox, not tet.json, is the truth for this one
   *  field: the dialog opens with the rules actually attached (sbx.ts's readLiveSbxConfig). */
  hosts: string[];
}

/** What the sbx-settings dialog asks before it shows its fields — see sbx.ts's readSbxStatus.
 *  Each answer is only meaningful when the one above it is true. */
export interface SbxStatus {
  installed: boolean;
  loggedIn: boolean;
  policyInitialized: boolean;
  /** An organization manages one of the account's policies; the dialog shows a wall instead. */
  governed: boolean;
}

/** A project with no `sbx` section in its tet.json, and what the dialog mounts with. */
export const EMPTY_SBX_CONFIG: SbxProjectConfig = {
  enabled: false,
  knowledge: { skills: false, plugins: false, instructions: false },
  ports: [],
  paths: [],
  hosts: []
};

/** The Prompts tab's picker. */
export const PROMPT_IDS: PromptId[] = ["commitMessage"];

/** The Files tab's keybinding-preset fallback, shared so main and renderer can't drift apart. */
export const DEFAULT_KEYBINDING_PRESET_ID = "vscode";

/** What tet *is* rather than what it is set to — the settings dialog's Info tab, read once. */
export interface AppInfo {
  /** package.json's version, which is what the installers are named after. */
  version: string;
  electron: string;
  chromium: string;
  node: string;
  /** `process.platform` and `process.arch`, spelled the way node spells them. */
  os: string;
}

/** How clone and create answer: the project once its folder is open, or git's own message. */
export interface AddRepositoryResult {
  project?: Project;
  error?: string;
  /** See GitActionResult: the clone wants credentials, and the dialog asks for them. */
  authRequired?: boolean;
}

export type ProviderId = "github" | "gitlab";

/** A configured account of a repository host. The token lives with it, encrypted, main-side. */
export interface ProviderAccount {
  id: string;
  provider: ProviderId;
  /** "github.com", or wherever a self-hosted instance answers. */
  host: string;
  /** The login the token belongs to, read from the API when the account was added. */
  user: string;
  /** The group the list was last narrowed to; "" is all of them, undefined means never picked. */
  namespace?: string;
}

/** One repository the remote tab lists, in the shape its rows and the clone tab need. */
export interface RemoteRepository {
  /** "owner/name", the way both hosts spell it. */
  fullName: string;
  /** The default folder name of a clone, which the clone tab is prefilled with. */
  name: string;
  private: boolean;
  /** The https url git clones; the account's token can authenticate it. */
  cloneUrl: string;
}

/** How adding an account answers: the account once its token checked out, or the API's message. */
export interface AddAccountResult {
  account?: ProviderAccount;
  error?: string;
}

export interface ListRepositoriesResult {
  repos?: RemoteRepository[];
  error?: string;
}

/** One saved shell command of a project; `cwd` is where it runs, relative to the project root. */
export interface ProjectCommand {
  command: string;
  /** What the row calls it where the command line reads badly. Only a label; the line is what runs. */
  name?: string;
  /** Relative to the project root; absent means the root itself. */
  cwd?: string;
  /** Environment variables the command runs with — its own field because `PROFILE=x java ...` is
   *  POSIX syntax PowerShell reads as a command name. These win over the inherited ones. */
  env?: Record<string, string>;
  /** Hands the command to a shell instead of starting the program — for one that really needs a
   *  pipe or a redirection, and then only works on the platform it was written for. */
  shell?: boolean;
}

export interface RemoteInfo {
  name: string;
  /** Branch names without the remote prefix, e.g. "development". */
  branches: string[];
  /** e.g. "git@github.com:owner/repo.git"; read when the project opens, not on every refresh. */
  url?: string;
}

/** What can be done with a stash from its row: put it back, put it back and drop it, or drop it. */
export type StashCommand = "apply" | "pop" | "drop";

export interface StashEntry {
  /** What the stash commands take, e.g. "stash@{0}". Not stable: dropping one renumbers the rest. */
  ref: string;
  /** git's own line for it, e.g. "WIP on main: 1a2b3c the last commit's subject". */
  message: string;
}

/** A merge or a rebase git stopped half-way through, so the UI can offer to abort it. */
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
  /** The branch HEAD tracks, e.g. "origin/main"; absent when it tracks none or none exists. */
  upstream?: string;
  /** Commits HEAD has that its upstream does not, and the other way round. Both 0 without one. */
  ahead: number;
  behind: number;
  localBranches: string[];
  /** Ahead/behind for a local branch that is *not* the current one, held only once
   *  `%(upstream:trackshort)` has confirmed it differs — the count costs a `rev-list`. Absent for a
   *  branch in sync, with no upstream, or the checked-out one, whose numbers are `ahead`/`behind`. */
  branchTrack: Record<string, { ahead: number; behind: number }>;
  remotes: RemoteInfo[];
  /** The branch the first remote's HEAD points at, e.g. "main"; absent where none was published. */
  defaultBranch?: string;
  /** Tag names, as `for-each-ref` orders them. */
  tags: string[];
  stashes: StashEntry[];
  changes: FileChange[];
  /** A merge or rebase git is half-way through; the branch menu offers to abort it. */
  operation?: GitOperation;
  /** Set when git could not be run or the folder is not a repository; the rest is then empty. */
  error?: string;
}

/** A repository nothing has been read from. Never mutated, only spread from. */
export const EMPTY_REPOSITORY_STATE: RepositoryState = {
  head: "",
  detached: false,
  ahead: 0,
  behind: 0,
  localBranches: [],
  branchTrack: {},
  remotes: [],
  tags: [],
  stashes: [],
  changes: []
};

/** How loudly a notice asks to be read; all three disappear after 8 seconds or on click. */
export type NoticeSeverity = "error" | "warning" | "info";

/** Anything the user is told, without exception — not a *status*, which a view draws for itself. */
export interface Notice {
  severity: NoticeSeverity;
  message: string;
  /** 0-100 while a download the notice is tracking is under way; omitted for a plain notice. */
  progress?: number;
}

export type DiffLineType = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  /** Line number in the old file; absent for added lines. On a hunk header, where it starts. */
  oldLine?: number;
  /** Line number in the new file; absent for deleted lines. On a hunk header, where it starts. */
  newLine?: number;
  text: string;
}

/** Both versions of an image as data URLs; either is absent when the file was added or deleted. */
export interface ImageDiff {
  before?: string;
  after?: string;
}

export interface FileDiff {
  path: string;
  lines: DiffLine[];
  binary: boolean;
  /** True when `lines` was cut off because the diff is very large. */
  truncated: boolean;
  /** Set instead of `lines` when the file is an image git could only call binary. */
  image?: ImageDiff;
  error?: string;
}

/** How a diff is read; the view's own switches, not anything about the file. */
export interface DiffOptions {
  /** `git diff -w`: lines that differ only in spacing stop counting as changes. */
  ignoreWhitespace?: boolean;
}

/** A file's content for the diff dialog's editor — read once per open, not streamed. */
export interface FileContent {
  path: string;
  content: string;
  /** Compared against on save, so a write started here never clobbers an outside edit. */
  mtimeMs: number;
  binary: boolean;
  tooLarge: boolean;
  /** Set instead of `content` when the file is an image git diffs would also call binary. */
  image?: string;
  error?: string;
}

/** What a save reports: written, or why not — a stale `mtimeMs` never overwrites silently. */
export interface FileWriteResult {
  ok: boolean;
  mtimeMs?: number;
  error?: string;
}

/**
 * Every file in the repository, for the diff dialog's Explorer tree — a real filesystem scan, not
 * `git ls-files`: git cannot represent an empty directory at all. `emptyDirs` holds only the
 * directories nothing in `files` implies. `.git` is always left out; anything else only on the
 * project's say-so. The listing also carries the project's view settings from `tet.json`, so the
 * tree gets configuration and data in one read; `roots` is absent when there is no `folders` list.
 * Paths stay repository-relative and each file is listed once, whichever roots contain it.
 */
export interface ExplorerListing {
  files: string[];
  emptyDirs: string[];
  roots?: ExplorerRoot[];
  compactFolders: boolean;
  sortOrder: ExplorerSortOrder;
  /** Modification time per listed path, files and directories alike — only read for `modified`. */
  mtimes?: Record<string, number>;
}

/** One entry of a `folders` list: a top-level node of the tree, labelled `name`. */
export interface ExplorerRoot {
  name: string;
  /** Repository-relative, forward-slashed; "" for the repository root itself. */
  path: string;
}

/** VS Code's `explorer.sortOrder` values. `foldersNestsFiles` is `default` without file nesting. */
export type ExplorerSortOrder = "default" | "mixed" | "filesFirst" | "type" | "modified" | "foldersNestsFiles";

/** The Explorer settings the settings dialog's Files tab edits directly, read on its own. */
export interface ExplorerSettings {
  excludeGitIgnore: boolean;
  compactFolders: boolean;
  sortOrder: ExplorerSortOrder;
}

/** What any git action the UI starts reports back: it worked, or what git said when it didn't. */
export interface GitActionResult {
  ok: boolean;
  error?: string;
  /** git stopped for want of credentials; only a network command sets it, only the clone acts on it. */
  authRequired?: boolean;
}

/** A branch to check out: a local branch, or a remote-tracking one like "origin/development". */
export interface CheckoutTarget {
  name: string;
  remote?: string;
}

/** One terminal's output since the last flush. They cross to the renderer in batches: one message
 *  per tab per flush would grow the message count with the number of open terminals. */
export interface TerminalOutput {
  projectId: string;
  tabId: string;
  data: string;
}

export type TerminalStatus = "missing" | "ready" | "running" | "stopped" | "error";

export interface TerminalDescriptor {
  /** Unique within its project; equals the agent's session id for a restored tab. */
  tabId: string;
  projectId: string;
  agentId: AgentId;
  /** Session title; "" makes the UI show a placeholder. */
  title: string;
  status: TerminalStatus;
  /** The agent's own id for this session; absent until the CLI has persisted one. Equal to `tabId`
   *  for a restored tab, which is why the split layout keys its pane assignments by it. */
  sessionId?: string;
  /** Last activity, ms since epoch; absent for tabs without a session. */
  updatedAt?: number;
  /** Creation time, ms since epoch; absent for tabs without a session. */
  createdAt?: number;
  /** When this session last finished a turn unseen, ms since epoch; cleared once the tab is on
   *  screen (`terminals.seen`). A time, not a flag: the project row's mark opens the oldest first. */
  finishedAt?: number;
  /** Whether the agent is working on a turn — reported by the agent at both ends, never read off
   *  the TUI. Always false for a tab whose process has ended, whatever the agent last said. */
  busy?: boolean;
  /** Whether *this* tab is what a progress bar is about — its runtime still being prepared, or its
   *  CLI not past its first frame — so its own pane shows the bar. Read off the session manager's
   *  per-tab indicator count at every snapshot, not kept on the tab. */
  starting?: boolean;
  /** When this session last stopped mid-turn on an unanswered question, ms since epoch. Cleared like
   *  `finishedAt`, and by either end of a turn. Its own field rather than a shade of `busy`: such a
   *  session is *not* working. */
  waitingAt?: number;
  /** Whether this tab's process is a saved command; only then does the context menu offer Restart. */
  savedCommand?: boolean;
  /** The saved command's line as written in `tet.json` — what the split layout keys `commandPane`
   *  by, so the next run lands where the last one lay. The line, not the `name`, which may be missing. */
  command?: string;
}
