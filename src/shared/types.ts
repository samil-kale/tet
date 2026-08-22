export type AgentId = "claude" | "opencode" | "codex" | "shell";

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  /** Whether this agent persists sessions; the shell does not, so its tabs are just terminals. */
  hasSessions: boolean;
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

/**
 * What the startup check found. `met` is git *and* at least one agent — anything less and the
 * app does not open: git is the whole git side, and an agent is what the terminals are for.
 */
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
  /** The agent has been idle waiting for the next prompt — usually redundant with `finished`. */
  idleReminder: boolean;
}

/**
 * Everything the settings dialog holds, and everything tet keeps about itself rather than
 * about one repository. Written whole, so a new group is a new key here and a new section
 * there.
 */
export interface AppSettings {
  notifications: NotificationSettings;
  /** The Files tab's keybinding preset picker; an id out of `KEYBINDING_PRESETS`,
   *  `DEFAULT_KEYBINDING_PRESET_ID` its default. */
  editorKeybindingPreset: string;
}

/** The Files tab's keybinding-preset fallback, shared so main and renderer can't drift apart —
 *  matches `KEYBINDING_PRESETS[0].id`. */
export const DEFAULT_KEYBINDING_PRESET_ID = "vscode";

/**
 * What tet *is*, as opposed to what it is set to — the settings dialog's Info tab. Read once
 * when the dialog opens: none of it can change while the process runs.
 */
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
  /**
   * The group the remote tab's list was last narrowed to, "" for all of them. Undefined until
   * one was picked, which is what lets the tab fall back to wherever the most recent activity
   * was instead of overruling a choice that was never made.
   */
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

/**
 * One saved shell command of a project. `cwd` is where it runs, relative to the project root —
 * a monorepo's frontend scripts belong to the folder that declares them, and writing
 * `npm run build` next to the folder it runs in reads better than the flag that would move it
 * ("--prefix", "-C", "--project"), which not every tool even has.
 */
export interface ProjectCommand {
  command: string;
  /**
   * What the row calls it, where the command line itself is not the clearest thing to read —
   * "Start the backend" over `mvn compile exec:java -Dexec.mainClass=...`. Only a label: the
   * line is what runs, and the tooltip is where it stays visible.
   */
  name?: string;
  /** Relative to the project root; absent means the root itself. */
  cwd?: string;
  /**
   * Environment variables the command runs with. Its own field because there is no way to
   * write one *into* a command that works everywhere: `PROFILE=x java -jar ...` is POSIX
   * syntax that PowerShell reads as a command name. These win over the ones inherited from
   * the machine — the command says what it needs.
   */
  env?: Record<string, string>;
  /**
   * Hands the command to a shell instead of starting the program itself — for the one that
   * really needs a pipe or a redirection, and then only works on the platform it was written
   * for. Off by default: with no shell in the way there is no syntax to differ between
   * machines.
   */
  shell?: boolean;
}

export interface RemoteInfo {
  name: string;
  /** Branch names without the remote prefix, e.g. "development". */
  branches: string[];
  /**
   * What it was configured with, e.g. "git@github.com:owner/repo.git". Read when the project
   * opens rather than on every refresh — a remote's url changes about never.
   */
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
  /**
   * Ahead/behind for a local branch that is *not* the current one, so the tree can show it next
   * to every diverged row the way sourcegit does — cheap for `for-each-ref`'s own
   * `%(upstream:trackshort)` to say a branch differs from its upstream at all, but the count is
   * a `rev-list` of its own, so this only holds a branch once it is confirmed to differ.
   * Absent for a branch in sync, with no upstream, or the checked-out one — that one's numbers
   * are `ahead`/`behind` above, already read from the status header for free.
   */
  branchTrack: Record<string, { ahead: number; behind: number }>;
  remotes: RemoteInfo[];
  /**
   * The branch the first remote's HEAD points at, e.g. "main" — what "Update from main"
   * merges in. Absent where the remote never published one.
   */
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

/**
 * A repository nothing has been read from — the state before the first refresh, behind an
 * error, or of a project that is not open. One constant rather than a literal per caller: four
 * copies of it drifted around the code. Never mutated, only spread from.
 */
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

/**
 * How loudly a notice asks to be read. Only "info" goes away on its own; the other two wait
 * to be dismissed, because nobody should have to catch a failure as it passes by.
 */
export type NoticeSeverity = "error" | "warning" | "info";

/**
 * Anything the user is told, without exception — see the CLAUDE.md section. Not to be confused
 * with a *status* (a tab colored for a missing agent, a progress bar), which a view does draw
 * for itself.
 */
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
 * `git ls-files`: git has no way to represent an empty directory at all, in any of its objects,
 * so a scan is the only way one can ever show up. `emptyDirs` is only the directories that would
 * otherwise be invisible (nothing to infer them from in `files`); a non-empty one is already
 * implied by the paths that pass through it. `.git` is always left out; anything else only on
 * the project's say-so — `exclude` globs and, opted into, what `.gitignore` hides (see
 * "Explorer" in CLAUDE.md).
 *
 * The listing also carries the project's own view settings from `tet.json`, so the tree gets
 * configuration and data in one read: `roots` for a `folders` list (absent when there is none —
 * the whole repository is the one tree then), and the sort and compaction rules. Paths stay
 * repository-relative throughout and each file is listed once, whichever roots contain it.
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
  /**
   * Whether git stopped for want of credentials rather than for any other reason. Only a
   * command that reaches a remote ever sets it, and only the clone acts on it — by offering an
   * account or a token and running again.
   */
  authRequired?: boolean;
}

/** A branch to check out: a local branch, or a remote-tracking one like "origin/development". */
export interface CheckoutTarget {
  name: string;
  remote?: string;
}

/**
 * One terminal's output since the last flush. They cross to the renderer in batches: with
 * several agents redrawing their TUIs at once, one message per tab per flush would grow the
 * message count with the number of open terminals for no gain.
 */
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
  /**
   * The agent's own id for this tab's session; absent while a fresh tab's CLI hasn't persisted
   * one yet — nothing to rename then. Equal to `tabId` for a restored tab, and what a tab
   * created during this run comes back as after a restart, which is why the split layout keys
   * its persisted pane assignments by it rather than by `tabId`.
   */
  sessionId?: string;
  /** Last activity, ms since epoch; absent for tabs without a session. */
  updatedAt?: number;
  /** Creation time, ms since epoch; absent for tabs without a session. */
  createdAt?: number;
  /**
   * When this session last finished a turn without having been looked at since, ms since
   * epoch — what the mark in the tab and in the project row stands for. Cleared the moment the
   * tab is on screen (`terminals.seen`). A time rather than a flag because the project row's
   * mark opens the *oldest* one first, and clicking it again the next.
   */
  finishedAt?: number;
  /**
   * Whether the agent is working on a turn right now — the spinner in place of the tab's
   * agent icon. Reported by the agent itself at both ends of the turn, so it is a state and
   * not a guess: nothing here is derived from what the TUI drew. Always false for a tab whose
   * process has ended, whatever the agent last said.
   */
  busy?: boolean;
  /**
   * Whether *this* tab is what a progress bar is currently about — its agent's runtime still
   * being prepared, or its CLI not yet past its first real frame. What lets the pane this tab
   * lives in show the bar itself instead of every pane borrowing the first one's; the
   * project-wide `terminal:startup-progress` only says that *something* in the project is.
   * Read off the session manager's per-tab indicator count at every snapshot, not kept on the
   * tab.
   */
  starting?: boolean;
  /**
   * When this session last stopped mid-turn on a question nobody has answered yet — a
   * permission prompt, an elicitation, or an `AskUserQuestion` — ms since epoch. Cleared the
   * moment the tab is on screen, exactly like `finishedAt`, and by either end of a turn.
   *
   * Its own field rather than a shade of `busy`, because it is the opposite of it: such a
   * session is *not* working, and nothing moves until the user answers. A time rather than a
   * flag for `finishedAt`'s reason — the project row's mark opens the oldest one first.
   */
  waitingAt?: number;
  /**
   * Whether this tab's process is a saved command rather than an agent or an interactive shell
   * — the one case where "run this again" means something, so the tab's context menu offers
   * Restart only when this is true.
   */
  savedCommand?: boolean;
}
