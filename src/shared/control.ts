import { COLOR_SCHEMES, PROMPT_IDS, TERMINAL_STATUSES } from "./types";

/**
 * The control channel's wire contract, shared by `src/main/control/control-server.ts` and
 * `src/cli/tet-ctl.ts`. No electron or node imports: the CLI is bundled on its own.
 *
 * One HTTP POST per connection: JSON in, JSON out, connection closed. No ids, no pipelining — one
 * CLI process per invocation.
 */

/** Set on every pty tet spawns; the CLI's whole configuration. */
export const CONTROL_ENV = {
  port: "TET_CONTROL_PORT",
  token: "TET_CONTROL_TOKEN",
  projectId: "TET_PROJECT_ID",
  tabId: "TET_TAB_ID",
  /** Only sbx sessions set it ("host.docker.internal" — the sandbox has its own loopback); unset
   *  means "127.0.0.1". Also needs the policy allow in sbx.ts's isControlChannelAllowed. */
  host: "TET_CONTROL_HOST"
} as const;

export type ControlErrorCode = "unauthorized" | "unknown_verb" | "bad_args" | "not_found" | "internal" | "timeout";

export interface ControlRequest {
  /** The caller's tab's token (src/main/control/control-token.ts); the run's own without a caller. */
  token: string;
  verb: string;
  args: Record<string, unknown>;
  /** The tab the CLI ran in: the default project without `--project`, and a target a verb must
   *  answer *before* acting on. */
  caller: { projectId?: string; tabId?: string };
  /**
   * When the caller spoke, by its own clock. Turn signals are ordered by this, not by arrival: two
   * hooks of one turn race each other. A tab's reports all come from its own agent, so one clock.
   */
  at?: number;
}

export type ControlResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: ControlErrorCode; message: string } };

export interface ControlVerb {
  verb: string;
  usage: string;
  summary: string;
  /** Argument names for the positionals, in order; flags keep their own name (CONTROL_FLAGS). */
  positionals: string[];
  /** Only from a tab of the project it targets: the verb reads a terminal, and one project's
   *  agent has no business in another project's. */
  ownProjectOnly?: true;
  /** Left out of `tet-ctl help` (GROUPS in tet-ctl.ts names the rest): whoever reads that output is
   *  already running `help`, and `hook` is plumbing an agent's own hook command calls. */
  unlisted?: true;
  /**
   * What a caller running in an sbx sandbox may do; absent means refused, so a new verb is closed
   * to it until decided. `ownProject` answers only for the caller's own project. The sandbox is the
   * organization's policy: a verb that starts a process on this machine, or reads outside the
   * project it mounts, would walk around it.
   */
  sandbox?: "any" | "ownProject";
  /** Stdin goes in as `args.payload` — an agent's hook payload. */
  stdin?: true;
  /**
   * The CLI writes only `result.stdout`, verbatim, and never fails — a hook exiting non-zero can
   * hold back the prompt it reports.
   */
  stdout?: true;
}

/**
 * Hook events in tet's own vocabulary; each agent's hooks.ts maps its events onto these.
 * `permission` and `question` are one mark with two toast wordings; `session-start` marks nothing.
 */
export const HOOK_EVENTS = ["session-start", "prompt-submit", "stop", "permission", "question", "idle"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** A switch is `true` when given; a value flag takes the next argument. Every verb gets all flags
 *  and reads the ones it uses. */
export const CONTROL_FLAGS: Readonly<Record<string, "switch" | "value">> = {
  project: "value",
  agent: "value",
  confirm: "switch",
  enter: "switch",
  session: "switch",
  busy: "switch",
  idle: "switch",
  status: "value",
  tail: "value",
  kb: "value",
  timeout: "value",
  keep: "switch",
  force: "switch"
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

/** Every verb with its `tet-ctl help` line. The CLI answers `help` itself; the server refuses
 *  anything else not listed as `unknown_verb`. */
export const CONTROL_VERBS: ReadonlyArray<ControlVerb> = [
  // The CLI answers it and never asks the server, sandbox included.
  { verb: "help", usage: "help", summary: "Print this list.", positionals: [], sandbox: "any", unlisted: true },
  { verb: "version", usage: "version", summary: "TET's version.", positionals: [], sandbox: "any" },
  { verb: "list-themes", usage: "list-themes", summary: "The color themes (id, label and kind).", positionals: [], sandbox: "any" },
  {
    verb: "list-agents",
    usage: "list-agents",
    summary: "The supported agents and whether each is installed.",
    positionals: [],
    sandbox: "any"
  },
  { verb: "settings-get", usage: "settings-get", summary: "All of TET's settings.", positionals: [], sandbox: "any" },
  {
    verb: "settings-set-theme",
    usage: "settings-set-theme <theme-id>",
    summary: "Set the theme for its kind (light or dark, see list-themes). Shown at once while TET is drawn in that kind.",
    positionals: ["theme"]
  },
  {
    verb: "settings-set-color-scheme",
    usage: `settings-set-color-scheme <${COLOR_SCHEMES.join("|")}>`,
    summary: "Set light or dark, system following the OS.",
    positionals: ["scheme"]
  },
  {
    verb: "settings-set-prompt",
    usage: `settings-set-prompt <${PROMPT_IDS.join("|")}> [text]`,
    summary: "Set the text of a background question; no text puts TET's own back. Applies to the next press.",
    positionals: ["id", "text"]
  },
  { verb: "projects-list", usage: "projects-list", summary: "The open projects (id, name, path).", positionals: [], sandbox: "ownProject" },
  {
    verb: "repo-state",
    usage: "repo-state [--project <id>]",
    summary: "What the git pane shows for a project: branch, upstream, changed files, stashes.",
    positionals: [],
    sandbox: "ownProject"
  },
  { verb: "projects-add", usage: "projects-add <path>", summary: "Open a folder as a project.", positionals: ["path"] },
  {
    verb: "projects-remove",
    usage: "projects-remove <project-id>",
    summary: "Close a project (the folder stays).",
    positionals: ["projectId"]
  },
  {
    verb: "worktree-add",
    usage: "worktree-add <branch> [--project <id>]",
    summary:
      "Create a git worktree of the project under ~/.tet/worktrees with a new branch <branch> at the default branch, and open it as a project.",
    positionals: ["branch"]
  },
  {
    verb: "worktree-delete",
    usage: "worktree-delete <project-id> [--force]",
    summary:
      "Close a worktree's project and delete its folder and its branch. --force also deletes uncommitted changes. Never the caller's own project.",
    positionals: ["projectId"]
  },
  {
    verb: "tabs-list",
    usage: "tabs-list [--project <id>]",
    summary: "A project's terminal tabs and their state, with the session each tab's hooks named and its sandbox.",
    positionals: [],
    sandbox: "ownProject"
  },
  {
    verb: "tabs-start",
    usage: "tabs-start <tab-id> [--project <id>]",
    summary: "Start a tab's process without bringing it to the front.",
    positionals: ["tabId"]
  },
  {
    verb: "tabs-restart",
    usage: "tabs-restart <tab-id> [--project <id>]",
    summary: "Restart a tab that stopped or could not start, as its menu's Restart does.",
    positionals: ["tabId"]
  },
  {
    verb: "tabs-wait",
    usage: `tabs-wait <tab-id> [--session] [--busy] [--idle] [--status <${TERMINAL_STATUSES.join("|")}>] [--timeout <seconds>] [--project <id>]`,
    summary:
      "Wait until every condition given holds: a session (--session), working a turn (--busy), not working one (--idle), a status. Exits 4 after the timeout (30 s).",
    positionals: ["tabId"],
    sandbox: "ownProject"
  },
  {
    verb: "tabs-send",
    usage: "tabs-send <tab-id> <text> [--enter] [--project <id>]",
    summary: "Type text into a tab, then Enter with --enter, as if the user had typed it there.",
    positionals: ["tabId", "text"],
    ownProjectOnly: true
  },
  {
    verb: "tabs-output",
    usage: "tabs-output <tab-id> [--kb <n>]",
    summary:
      "The last n KB a tab printed (16, at most 256), escape sequences out and a redrawn line kept as last shown; an agent's TUI redraws in place, so its text comes in pieces.",
    positionals: ["tabId"],
    ownProjectOnly: true,
    sandbox: "ownProject"
  },
  {
    verb: "events-tail",
    usage: "events-tail [--tail <count>] [--project <id>]",
    summary: "The latest hook reports, session claims and closed tabs, with when each arrived.",
    positionals: [],
    sandbox: "ownProject"
  },
  {
    verb: "editor-open",
    usage: "editor-open <path> [--keep] [--project <id>]",
    summary:
      "Open a repository-relative file in the project's preview tab and bring it to the front; the next file replaces it, --keep gives it a tab of its own.",
    positionals: ["path"],
    sandbox: "ownProject"
  },
  {
    verb: "editor-state",
    usage: "editor-state [--project <id>]",
    summary: "What the project's active editor tab shows: the file, its text, whether it is edited, read-only or a preview.",
    positionals: [],
    sandbox: "ownProject"
  },
  {
    verb: "editor-list",
    usage: "editor-list [--project <id>]",
    summary: "The project's open editor tabs: file, preview, edited, read-only, and which one is active.",
    positionals: [],
    sandbox: "ownProject"
  },
  {
    verb: "explorer-list",
    usage: "explorer-list [--project <id>]",
    summary: "What the files view lists for a project, with tet.json's folders and excludes applied.",
    positionals: [],
    sandbox: "ownProject"
  },
  {
    verb: "notices-list",
    usage: "notices-list",
    summary: "The latest notices the window showed, oldest first.",
    positionals: [],
    sandbox: "any"
  },
  {
    verb: "tabs-create",
    usage: "tabs-create --agent <claude|opencode|codex|pi|shell> [--project <id>]",
    summary: "Open a new terminal tab for that agent.",
    positionals: [],
    sandbox: "ownProject"
  },
  {
    verb: "tabs-run-command",
    usage: "tabs-run-command <name> [--project <id>]",
    summary: "Run one of the project's saved commands (tet.json) in a new tab.",
    positionals: ["name"]
  },
  {
    verb: "tabs-close",
    usage: "tabs-close <tab-id> [--project <id>]",
    summary: "Close a tab and end its session.",
    positionals: ["tabId"],
    sandbox: "ownProject"
  },
  {
    verb: "tabs-rename",
    usage: "tabs-rename <tab-id> <title> [--project <id>]",
    summary: "Rename a tab.",
    positionals: ["tabId", "title"],
    sandbox: "ownProject"
  },
  {
    verb: "restart-app",
    usage: "restart-app --confirm",
    summary: "Restart TET. Ends every terminal in every project, this one included — only when the user asked for it.",
    positionals: []
  },
  {
    verb: "notify",
    usage: "notify <title> [body]",
    summary: "Show a desktop notification from TET's own process — the one with a desktop session.",
    positionals: ["title", "body"],
    sandbox: "any"
  },
  {
    verb: "hook",
    usage: "hook <event>",
    summary: `An agent's hook reports a turn (${HOOK_EVENTS.join("|")}). Not for you to call.`,
    positionals: ["event"],
    unlisted: true,
    stdin: true,
    stdout: true,
    sandbox: "any"
  }
];

export const HELP_VERB = "help";

/** `tet-ctl`'s exit codes, for an agent to branch on. */
export const EXIT_CODES = {
  ok: 0,
  internal: 1,
  unauthorized: 2,
  usage: 3,
  /** `tabs-wait` gave up. */
  timeout: 4
} as const;
