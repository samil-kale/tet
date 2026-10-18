import { SBX_SKILLS_KINDS } from "./sbx-rules";
import { EXPLORER_SORT_ORDERS } from "./types/files";
import { COLOR_SCHEMES, GIT_SETTING_IDS, NOTIFICATION_IDS, PROMPT_IDS } from "./types/settings";
import { TERMINAL_STATUSES } from "./types/terminals";

/**
 * The control channel's wire contract, shared by `src/main/ctl/ctl-server.ts` and
 * `src/cli/tet-ctl.ts`. No electron or node imports: the CLI is bundled on its own.
 *
 * One HTTP POST per connection: JSON in, JSON out, connection closed. No ids, no pipelining — one
 * CLI process per invocation.
 */

/** Set on every pty TET spawns; the CLI's whole configuration. */
export const CONTROL_ENV = {
  port: "TET_CONTROL_PORT",
  token: "TET_CONTROL_TOKEN",
  projectId: "TET_PROJECT_ID",
  /** The worktree's key; unset in a project's repository. */
  worktree: "TET_WORKTREE",
  tabId: "TET_TAB_ID",
  /** Only sbx sessions set it ("host.docker.internal" — the sandbox has its own loopback); unset
   *  means CONTROL_HOST. Also needs the policy allow in sbx-status.ts's isControlChannelAllowed. */
  host: "TET_CONTROL_HOST",
} as const;

/** Where the server listens, and where a caller outside a sandbox reaches it. */
export const CONTROL_HOST = "127.0.0.1";

export type ControlErrorCode = "unauthorized" | "unknown_verb" | "bad_args" | "not_found" | "internal" | "timeout";

export interface ControlRequest {
  /** The caller's tab's token (src/main/terminals/ctl-token.ts); the run's own without a caller. */
  token: string;
  verb: string;
  args: Record<string, unknown>;
  /** The tab the CLI ran in, and the worktree it runs in: the default target without `--project`
   *  or `--worktree`, and a target a verb must answer *before* acting on. */
  caller: { projectId?: string; worktree?: string; tabId?: string };
  /**
   * When the caller spoke, by its own clock. Turn reports are ordered by this, not by arrival: two
   * hooks of one turn race each other.
   */
  at?: number;
}

export type ControlResponse = { ok: true; result: unknown } | { ok: false; error: { code: ControlErrorCode; message: string } };

/** The headings `tet-ctl help` groups its verbs under, in the order it prints them. */
export const CONTROL_GROUPS = [
  "App",
  "Settings",
  "Projects",
  "Worktrees",
  "Repository",
  "Tabs",
  "Editor",
  "Notices",
  "SBX",
  "Environment",
] as const;

type ControlGroup = (typeof CONTROL_GROUPS)[number];

export interface ControlVerb {
  verb: string;
  usage: string;
  summary: string;
  /** Argument names for the positionals, in order; flags keep their own name (CONTROL_FLAGS). */
  positionals: readonly string[];
  /** The heading `tet-ctl help` prints the verb under; within one, the order is this list's.
   *  Absent only on an unlisted verb. */
  group?: ControlGroup;
  /** Left out of `tet-ctl help`: whoever reads that output is already running `help`, and `hook`
   *  is plumbing an agent's own hook command calls. */
  unlisted?: true;
  /**
   * What a caller running in an sbx sandbox may do; absent means refused, so a new verb is closed
   * to it until decided. `ownRef` answers only for the caller's own repository or worktree, the one
   * its sandbox mounts; `ownProject` for its project's repository and every worktree — the worktree
   * verbs, and the tab verbs, which reach there only tabs running in a sandbox
   * (CallerSide.reachesTab); `any` as far as from a host tab
   * (HOST_SIDE.reach). The sandbox is the organization's policy: a verb that starts a process on
   * this machine, or reads outside the project it mounts, would walk around it.
   */
  sandbox?: "any" | "ownRef" | "ownProject";
  /**
   * The key of the answer that names a file of the caller's project. A sandboxed caller gets it
   * only where the file really is inside the repository: a link committed or made in the mounted
   * repository would otherwise hand it a file of this machine. Enforced centrally, beside
   * `sandbox`, so a new verb that gives out a file cannot leave it out.
   */
  sandboxFile?: string;
  /** The last positional takes every argument left, as a list. */
  variadic?: true;
  /** Stdin goes in as `args.payload` — an agent's hook payload. */
  stdin?: true;
  /**
   * The CLI writes only `result.stdout`, verbatim, and never fails — a hook exiting non-zero can
   * hold back the prompt it reports.
   */
  stdout?: true;
}

/**
 * Hook events in TET's own vocabulary; each agent's hooks (pi: its extension) map its events onto
 * these.
 * `permission` and `question` are one mark with two notification wordings, `answered` clears it;
 * `session-start` marks nothing.
 */
export const HOOK_EVENTS = ["session-start", "prompt-submit", "stop", "permission", "question", "answered", "idle"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** A switch is `true` when given; a value flag takes the next argument. Every verb gets all flags
 *  and reads the ones it uses. */
export const CONTROL_FLAGS: Readonly<Record<string, "switch" | "value">> = {
  project: "value",
  worktree: "value",
  agent: "value",
  confirm: "switch",
  prompt: "value",
  session: "switch",
  working: "switch",
  stopped: "switch",
  status: "value",
  tail: "value",
  kb: "value",
  timeout: "value",
  keep: "switch",
  background: "switch",
  force: "switch",
  auth: "switch",
};

/** The size `tabs-start` and `tabs-restart` give a tab no window has fitted yet: what its output is
 *  drawn for until one does, and so the size `tabs-output` reads it at. */
export const CONTROL_START_SIZE = { cols: 120, rows: 30 };

/** What `tabs-keys` presses, as a terminal sends each key. Single keys only: a burst of text is a
 *  paste to an agent's TUI, `tabs-text`'s. */
export const TAB_KEYS: Readonly<Record<string, string>> = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  backspace: "\x7f",
  "ctrl-c": "\x03",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

/** An `events-tail` entry: what the session manager heard, in arrival order. */
export interface ControlEvent {
  /** When it arrived here, ms since epoch. */
  at: number;
  tabId: string;
  /** A hook report; a tab claiming a reported session (reconcile); a closed tab. */
  kind: "hook" | "claimed" | "closed";
  /** The hook's event, for `hook`. */
  event?: HookEvent;
  /** ControlRequest.at, for `hook`. */
  reportedAt?: number;
  /** The session the report named, or the one claimed. */
  sessionId?: string;
}

const VERBS = [
  // The CLI answers it and never asks the server, sandbox included.
  { verb: "help", usage: "help", summary: "Print this list.", positionals: [], sandbox: "any", unlisted: true },
  { verb: "version", group: "App", usage: "version", summary: "TET's version.", positionals: [], sandbox: "any" },
  { verb: "settings-get", group: "Settings", usage: "settings-get", summary: "All of TET's settings.", positionals: [], sandbox: "any" },
  {
    verb: "themes-list",
    group: "Settings",
    usage: "themes-list",
    summary: "The color themes (id, label and kind).",
    positionals: [],
    sandbox: "any",
  },
  {
    verb: "keybinding-presets-list",
    group: "Settings",
    usage: "keybinding-presets-list",
    summary: "The file editor's keybinding presets (id and label).",
    positionals: [],
    sandbox: "any",
  },
  {
    verb: "agents-list",
    group: "Settings",
    usage: "agents-list",
    summary: "The supported agents and whether each is installed.",
    positionals: [],
    sandbox: "any",
  },
  {
    verb: "settings-set-theme",
    group: "Settings",
    usage: "settings-set-theme <theme-id>",
    summary: "Set the theme of its kind (light or dark, see themes-list). Shown at once while TET is drawn in that kind.",
    positionals: ["theme"],
  },
  {
    verb: "settings-set-color-scheme",
    group: "Settings",
    usage: `settings-set-color-scheme <${COLOR_SCHEMES.join("|")}>`,
    summary: "Set light or dark, system following the OS.",
    positionals: ["scheme"],
  },
  {
    verb: "settings-set-prompt",
    group: "Settings",
    usage: `settings-set-prompt <${PROMPT_IDS.join("|")}> [text]`,
    summary:
      "Set the text of a prompt TET sends an agent: a background question or a handover's first prompt. No text restores TET's own. Applies from the next use.",
    positionals: ["id", "text"],
  },
  {
    verb: "settings-set-keybindings",
    group: "Settings",
    usage: "settings-set-keybindings <preset-id>",
    summary: "Set the file editor's keybindings to a preset (see keybinding-presets-list). Applies to editor tabs opened afterwards.",
    positionals: ["preset"],
  },
  {
    verb: "settings-set-notification",
    group: "Settings",
    usage: `settings-set-notification <${NOTIFICATION_IDS.join("|")}> <on|off>`,
    summary:
      "Switch a desktop notification: a finished turn, an agent waiting for an answer, or an idle reminder (Claude Code only; applies to tabs started afterwards).",
    positionals: ["id", "value"],
  },
  {
    verb: "settings-set-explorer",
    group: "Settings",
    usage: `settings-set-explorer <excludeGitIgnore|compactFolders> <on|off> | settings-set-explorer sortOrder <${EXPLORER_SORT_ORDERS.join("|")}>`,
    summary:
      "Set how the Explorer lists every project: hide what git ignores too, compact single-child folders, or the sort order. Shown at once.",
    positionals: ["id", "value"],
  },
  {
    verb: "settings-set-git",
    group: "Settings",
    usage: `settings-set-git <${GIT_SETTING_IDS.join("|")}> <on|off>`,
    summary:
      'Set how git\'s checkboxes start: new changes checked, "Also push" on commit, and deleting a branch, tag or worktree on the remote too.',
    positionals: ["id", "value"],
  },
  {
    verb: "settings-set-commit-suggesters",
    group: "Settings",
    usage: "settings-set-commit-suggesters <agent-id[=model]>...",
    summary:
      "Set who suggests commit messages, in the order they are asked until one answers: agents (see agents-list), each with one of its models; no model leaves it to the agent's own configuration. Agents left out are switched off.",
    positionals: ["suggesters"],
    variadic: true,
  },
  {
    verb: "projects-list",
    group: "Projects",
    usage: "projects-list",
    summary:
      "The open projects (id, name, path) with their worktrees (path, branch, key; one without a key was made elsewhere and cannot be opened).",
    positionals: [],
    sandbox: "ownProject",
  },
  {
    verb: "projects-add",
    group: "Projects",
    usage: "projects-add <path>",
    summary: "Open a folder as a project.",
    positionals: ["path"],
  },
  {
    verb: "projects-remove",
    group: "Projects",
    usage: "projects-remove --project <id> [--confirm]",
    summary:
      "Remove a project: deletes the worktrees TET made with their branches and TET's data of it; the repository's folder stays. With worktrees needs --confirm; refused while an editor tab of it has unsaved changes.",
    positionals: [],
  },
  {
    verb: "worktree-add",
    group: "Worktrees",
    usage: "worktree-add <branch> [--project <id>]",
    summary: "Add a worktree with a new branch <branch> at the default branch, under ~/.tet/projects, and open it with the project.",
    positionals: ["branch"],
    sandbox: "ownProject",
  },
  {
    verb: "worktree-delete",
    group: "Worktrees",
    usage: "worktree-delete <branch|key> [--project <id>] [--force]",
    summary:
      "Close the worktree of branch <branch> (or key) and delete it with its branch. --force also deletes uncommitted changes. Never the caller's own worktree.",
    positionals: ["branch"],
    sandbox: "ownProject",
  },
  {
    verb: "worktree-agent-merge",
    group: "Worktrees",
    usage: "worktree-agent-merge <branch|key> [--project <id>]",
    summary:
      "Merge the worktree's base into it, fast-forward the base in the repository, then delete the worktree with its branch. On a conflict it answers the files and where to resolve them: resolve, commit, run it again. Only from the repository, since deleting a worktree closes its tabs.",
    positionals: ["branch"],
    sandbox: "ownProject",
  },
  {
    verb: "repository-get",
    group: "Repository",
    usage: "repository-get [TARGET]",
    summary: "What the git lane shows for the repository or a worktree: branch, upstream, changed files, stashes.",
    positionals: [],
    sandbox: "ownRef",
  },
  {
    verb: "sbx-get",
    group: "SBX",
    usage: "sbx-get [--project <id>]",
    summary:
      "A project's SBX Settings: sbx's status, the configuration, which environment variables hold a value (never the values), and the problems per option (what cannot be applied here). Every sbx-set-* saves only what can be applied and answers notApplied (what was left out, and why) and restartRequired.",
    positionals: [],
    sandbox: "ownProject",
  },
  {
    verb: "sbx-accounts",
    group: "SBX",
    usage: "sbx-accounts",
    summary: "Whether sbx is signed in to Docker and as whom, and the users whose access tokens TET keeps (never a token).",
    positionals: [],
  },
  {
    verb: "sbx-sign-in",
    group: "SBX",
    usage: "sbx-sign-in <user>",
    summary:
      "Sign sbx in to Docker with the access token TET keeps for that user (running sandboxes keep running, the account's policy applies at once); notKept says why the token could not be kept afterwards. The user adds tokens in TET's SBX Settings, never you.",
    positionals: ["user"],
  },
  {
    verb: "sbx-set-enabled",
    group: "SBX",
    usage: "sbx-set-enabled <on|off> [--project <id>]",
    summary: "Run the project's agent tabs in sbx sandboxes, or not. Off removes its sandboxes.",
    positionals: ["value"],
  },
  {
    verb: "sbx-set-ports",
    group: "SBX",
    usage: "sbx-set-ports [<host>:<container>...] [--project <id>]",
    summary: "Replace the ports forwarded from this machine into the sandboxes; none clears them.",
    positionals: ["ports"],
    variadic: true,
  },
  {
    verb: "sbx-set-paths",
    group: "SBX",
    usage: "sbx-set-paths [<absolute-path>:<ro|rw>...] [--project <id>]",
    summary: "Replace the folders and files of this machine mounted into the sandboxes; none clears them.",
    positionals: ["paths"],
    variadic: true,
  },
  {
    verb: "sbx-set-hosts",
    group: "SBX",
    usage: "sbx-set-hosts [<host>...] [--project <id>]",
    summary: "Replace the hosts the sandboxes may reach beyond sbx's policy (host, *.domain, optional :port); none clears them.",
    positionals: ["hosts"],
    variadic: true,
  },
  {
    verb: "sbx-set-environment",
    group: "SBX",
    usage: "sbx-set-environment [<NAME>[=<value>]...] [--project <id>]",
    summary:
      "Replace the environment variables set in the sandboxes with their real value. NAME=value stores a value, a bare NAME keeps the stored one.",
    positionals: ["environment"],
    variadic: true,
    sandbox: "ownProject",
  },
  {
    verb: "sbx-set-mcp",
    group: "SBX",
    usage: "sbx-set-mcp [<NAME>[=<url>]...] [--auth] [--project <id>]",
    summary:
      "Replace the MCP servers loaded into the sandboxes. NAME=url registers it with sbx if new, a bare NAME uses one sbx has registered. A removed one is unloaded, its registration stays; none clears them. --auth then opens the user's browser for each of them that needs a sign-in, and waits.",
    positionals: ["servers"],
    variadic: true,
  },
  {
    verb: "sbx-set-skills",
    group: "SBX",
    usage: `sbx-set-skills <${SBX_SKILLS_KINDS.join("|")}> <off|ro|rw> [--project <id>]`,
    summary: "Mount the agents' own skills or instructions file (CLAUDE.md, AGENTS.md) into the sandboxes, or not.",
    positionals: ["kind", "access"],
  },
  {
    verb: "sbx-set-skills-folder",
    group: "SBX",
    usage: "sbx-set-skills-folder [absolute-path] [--project <id>]",
    summary: "Mount one folder as every agent's skills instead of each one's own; no path goes back to their own.",
    positionals: ["path"],
  },
  {
    verb: "app-restart",
    group: "App",
    usage: "app-restart --confirm",
    summary: "Restart TET, ending every tab in every project, this one included. Only when the user asked.",
    positionals: [],
  },
  {
    verb: "env-request",
    group: "Environment",
    usage: "env-request <NAME> [NAME...]",
    summary: "Open TET's dialog for the user to type environment variables into; waits for the answer. Every missing one in one request.",
    positionals: ["names"],
    variadic: true,
  },
  {
    verb: "env-list",
    group: "Environment",
    usage: "env-list",
    summary:
      "The environment variables TET sets (never their values); overridesMachine: the machine sets it too, and TET's value replaces it.",
    positionals: [],
  },
  {
    verb: "env-remove",
    group: "Environment",
    usage: "env-remove <NAME>",
    summary: "Delete an environment variable TET keeps.",
    positionals: ["name"],
  },
  {
    verb: "tabs-list",
    group: "Tabs",
    usage: "tabs-list [TARGET]",
    summary: "The tabs of the repository or a worktree with their state, the session each tab's hooks named and its sandbox.",
    positionals: [],
    sandbox: "ownProject",
  },
  {
    verb: "tabs-output",
    group: "Tabs",
    usage: "tabs-output <tab-id> [--kb <n>]",
    summary: "The last n KB (16) of what a tab's terminal shows, as text: scrollback and screen, or a fullscreen TUI's screen.",
    positionals: ["tabId"],
    sandbox: "ownProject",
  },
  {
    verb: "events-tail",
    group: "Tabs",
    usage: "events-tail [--tail <count>] [TARGET]",
    summary: "The latest hook reports, session claims and closed tabs, with when each arrived; shows why a tab shows what it shows.",
    positionals: [],
    sandbox: "ownProject",
  },
  {
    verb: "tabs-wait",
    group: "Tabs",
    usage: `tabs-wait <tab-id> [--session] [--working] [--stopped] [--status <${TERMINAL_STATUSES.join("|")}>] [--timeout <seconds>] [TARGET]`,
    summary:
      "Wait until every condition given holds: a session (--session), working a turn (--working), not working one (--stopped; a pending question counts), a status. Exits 4 after the timeout (30 s).",
    positionals: ["tabId"],
    sandbox: "ownProject",
  },
  {
    verb: "tabs-keys",
    group: "Tabs",
    usage: `tabs-keys <tab-id> <${Object.keys(TAB_KEYS).join("|")}>... [TARGET]`,
    summary:
      "Press keys in a tab, one after another, e.g. to answer a question tabs-output shows, or Enter to submit what tabs-text typed.",
    positionals: ["tabId", "keys"],
    variadic: true,
    sandbox: "ownProject",
  },
  {
    verb: "tabs-text",
    group: "Tabs",
    usage: "tabs-text <tab-id> <text> [TARGET]",
    summary:
      "Type text into a tab as one paste, without Enter (a TUI takes a newline in it as a new line); submit it with tabs-keys <tab-id> enter.",
    positionals: ["tabId", "text"],
    sandbox: "ownProject",
  },
  {
    verb: "tabs-create",
    group: "Tabs",
    usage: "tabs-create --agent <id> [--prompt <text>] [--background] [TARGET]",
    summary:
      "Open a terminal tab for an agent (an id from agents-list) and bring it to the front. With --prompt the agent starts on that task: the way to give another agent work.",
    positionals: [],
    sandbox: "ownProject",
  },
  {
    verb: "tabs-hand-over",
    group: "Tabs",
    usage: "tabs-hand-over <tab-id> --agent <id> [--background] [TARGET]",
    summary:
      "Open a tab of another agent (see agents-list) that takes over the tab's session by reading its transcript, e.g. after a usage limit, and bring it to the front. The first tab stays.",
    positionals: ["tabId"],
    sandbox: "ownProject",
  },
  {
    verb: "commands-list",
    group: "Tabs",
    usage: "commands-list [--project <id>]",
    summary: "The project's saved commands (tet.json): the names tabs-run-command takes.",
    positionals: [],
  },
  {
    verb: "tabs-run-command",
    group: "Tabs",
    usage: "tabs-run-command <name> [--background] [TARGET]",
    summary: "Run a saved command (tet.json) in a new tab of the repository or a worktree and bring it to the front.",
    positionals: ["name"],
  },
  {
    verb: "tabs-start",
    group: "Tabs",
    usage: "tabs-start <tab-id> [--background] [TARGET]",
    summary: "Start a tab's process and bring it to the front.",
    positionals: ["tabId"],
    sandbox: "ownProject",
  },
  {
    verb: "tabs-restart",
    group: "Tabs",
    usage: "tabs-restart <tab-id> [--background] [TARGET]",
    summary: "Restart a tab that stopped or could not start, as its menu's Restart does, and bring it to the front.",
    positionals: ["tabId"],
    sandbox: "ownProject",
  },
  {
    verb: "tabs-rename",
    group: "Tabs",
    usage: "tabs-rename <tab-id> <title> [TARGET]",
    summary: "Rename a tab.",
    positionals: ["tabId", "title"],
    sandbox: "ownProject",
  },
  {
    verb: "tabs-close",
    group: "Tabs",
    usage: "tabs-close <tab-id> [TARGET]",
    summary: "Close a tab and delete its session.",
    positionals: ["tabId"],
    sandbox: "ownProject",
  },
  {
    verb: "editor-open",
    group: "Editor",
    usage: "editor-open <path> [--keep] [--background] [TARGET]",
    summary:
      "Open a repository-relative file in the preview tab of the repository or a worktree and bring it to the front; the next file replaces it, --keep gives it a tab of its own.",
    positionals: ["path"],
    sandbox: "ownRef",
    sandboxFile: "opened",
  },
  {
    verb: "editor-get",
    group: "Editor",
    usage: "editor-get [TARGET]",
    summary:
      "What the active editor tab shows: file, text, edited, read-only or preview. Use it to see what the user has open and is editing.",
    positionals: [],
    sandbox: "ownRef",
    sandboxFile: "path",
  },
  {
    verb: "editor-list",
    group: "Editor",
    usage: "editor-list [TARGET]",
    summary: "The open editor tabs: file, preview, edited, read-only, and which is active. Use it to see what the user has open.",
    positionals: [],
    sandbox: "ownRef",
  },
  {
    verb: "explorer-list",
    group: "Repository",
    usage: "explorer-list [TARGET]",
    summary:
      "What the Explorer lists for the repository or a worktree, tet.json's folders and excludes applied: what the user sees, which ls does not show.",
    positionals: [],
    sandbox: "ownRef",
  },
  // Every notice, from a sandbox too: a notice names no repository or worktree to narrow it to, and
  // among them are those a sandboxed tab's own start raised (the tet.json rows it could not apply,
  // sbxProblemNotices).
  {
    verb: "notices-list",
    group: "Notices",
    usage: "notices-list",
    summary: "The latest notices the window showed the user (errors, warnings, results), oldest first.",
    positionals: [],
    sandbox: "any",
  },
  {
    verb: "notify",
    group: "Notices",
    usage: "notify <title> [body]",
    summary:
      "Show a desktop notification from TET's own process, the one with a desktop session, to call the user back: a long task is done or you need an answer.",
    positionals: ["title", "body"],
    sandbox: "any",
  },
  {
    verb: "hook",
    usage: "hook <event>",
    summary: `An agent's hook reports a turn (${HOOK_EVENTS.join("|")}). Not for you to call.`,
    positionals: ["event"],
    unlisted: true,
    stdin: true,
    stdout: true,
    sandbox: "any",
  },
] as const satisfies readonly ControlVerb[];

/** Every verb with its `tet-ctl help` line. The CLI answers `help` itself; the server refuses
 *  anything else not listed as `unknown_verb`. */
export const CONTROL_VERBS: readonly ControlVerb[] = VERBS;

/** A verb's name: the server's handlers are keyed by it, so a verb without one, or a handler
 *  without a verb, does not compile. */
export type ControlVerbName = (typeof VERBS)[number]["verb"];

export const HELP_VERB = "help";

/** `tet-ctl`'s exit codes, for an agent to branch on. */
export const EXIT_CODES = {
  ok: 0,
  internal: 1,
  unauthorized: 2,
  usage: 3,
  /** `tabs-wait` gave up. */
  timeout: 4,
} as const;

/** The exit code of each refusal; everything the caller could correct is `usage`. */
export const ERROR_EXIT_CODES: Record<ControlErrorCode, number> = {
  unauthorized: EXIT_CODES.unauthorized,
  internal: EXIT_CODES.internal,
  timeout: EXIT_CODES.timeout,
  unknown_verb: EXIT_CODES.usage,
  bad_args: EXIT_CODES.usage,
  not_found: EXIT_CODES.usage,
};
