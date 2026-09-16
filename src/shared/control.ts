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
  /**
   * Only in a run with its own `--user-data-dir` (tests): the verb types into another tab's
   * terminal, which would otherwise let one agent drive another.
   */
  ownProfileOnly?: true;
  /** Only from a tab of the project it targets: the verb reads a terminal, and one project's
   *  agent has no business in another project's. */
  ownProjectOnly?: true;
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
  lines: "value",
  timeout: "value"
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
  { verb: "help", usage: "help", summary: "Print this list.", positionals: [] },
  { verb: "version", usage: "version", summary: "TET's version.", positionals: [] },
  { verb: "list-themes", usage: "list-themes", summary: "The color themes (id, label and kind).", positionals: [] },
  {
    verb: "list-agents",
    usage: "list-agents",
    summary: "The supported agents and whether each is installed.",
    positionals: []
  },
  { verb: "settings-get", usage: "settings-get", summary: "All of TET's settings.", positionals: [] },
  {
    verb: "settings-set-theme",
    usage: "settings-set-theme <theme-id>",
    summary:
      "Set the theme for its kind (light or dark, see list-themes). Shown at once while TET is drawn in that kind; restartRequired says it waits for a restart — tell the user, do not restart for them.",
    positionals: ["theme"]
  },
  {
    verb: "settings-set-color-scheme",
    usage: `settings-set-color-scheme <${COLOR_SCHEMES.join("|")}>`,
    summary:
      "Set light or dark, system following the OS. restartRequired says it waits for a restart — tell the user, do not restart for them.",
    positionals: ["scheme"]
  },
  {
    verb: "settings-set-prompt",
    usage: `settings-set-prompt <${PROMPT_IDS.join("|")}> [text]`,
    summary: "Set the text of a background question; no text puts TET's own back. Applies to the next press.",
    positionals: ["id", "text"]
  },
  { verb: "projects-list", usage: "projects-list", summary: "The open projects (id, name, path).", positionals: [] },
  {
    verb: "repo-state",
    usage: "repo-state [--project <id>]",
    summary: "What the git pane shows for a project: branch, upstream, changed files, stashes.",
    positionals: []
  },
  { verb: "projects-add", usage: "projects-add <path>", summary: "Open a folder as a project.", positionals: ["path"] },
  {
    verb: "projects-remove",
    usage: "projects-remove <project-id>",
    summary: "Close a project (the folder stays).",
    positionals: ["projectId"]
  },
  {
    verb: "tabs-list",
    usage: "tabs-list [--project <id>]",
    summary: "A project's terminal tabs and their state, with the session each tab's hooks named and its sandbox.",
    positionals: []
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
      "Wait until a tab has a session (--session), is working a turn (--busy), is not (--idle) or has a status; every condition given must hold. Exits 4 after the timeout (30 s).",
    positionals: ["tabId"]
  },
  {
    verb: "tabs-send",
    usage: "tabs-send <tab-id> <text> [--enter] [--project <id>]",
    summary: "Type text into a tab, then Enter with --enter. Only in a run with its own --user-data-dir.",
    positionals: ["tabId", "text"],
    ownProfileOnly: true
  },
  {
    verb: "tabs-agent-output",
    usage: "tabs-agent-output <tab-id> [--kb <n>]",
    summary:
      "What an agent tab printed lately, escape sequences taken out: its TUI's redraws, the last n KB (4, at most 64). Only a tab of the caller's own project.",
    positionals: ["tabId"],
    ownProjectOnly: true
  },
  {
    verb: "tabs-shell-output",
    usage: "tabs-shell-output <tab-id> [--lines <n>]",
    summary:
      "The last n lines a shell tab printed (100, back as far as its last MB), escape sequences and redraws taken out. Only a tab of the caller's own project.",
    positionals: ["tabId"],
    ownProjectOnly: true
  },
  {
    verb: "events-tail",
    usage: "events-tail [--tail <count>] [--project <id>]",
    summary: "The latest hook reports, session claims and closed tabs, with when each arrived.",
    positionals: []
  },
  {
    verb: "editor-open",
    usage: "editor-open <path> [--project <id>]",
    summary: "Open a repository-relative file in the project's editor tab and bring it to the front.",
    positionals: ["path"]
  },
  {
    verb: "editor-state",
    usage: "editor-state [--project <id>]",
    summary: "What the project's editor tab shows: the file, its text, whether it is edited and whether it is read-only.",
    positionals: []
  },
  {
    verb: "explorer-list",
    usage: "explorer-list [--project <id>]",
    summary: "What the files view lists for a project, with tet.json's folders and excludes applied.",
    positionals: []
  },
  {
    verb: "notices-list",
    usage: "notices-list",
    summary: "The latest notices the window showed, oldest first.",
    positionals: []
  },
  {
    verb: "tabs-create",
    usage: "tabs-create --agent <claude|opencode|codex|pi|shell> [--project <id>]",
    summary: "Open a new terminal tab for that agent.",
    positionals: []
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
    positionals: ["tabId"]
  },
  {
    verb: "tabs-rename",
    usage: "tabs-rename <tab-id> <title> [--project <id>]",
    summary: "Rename a tab.",
    positionals: ["tabId", "title"]
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
    summary: "Show a desktop notification from TET's own process — the one with a desktop session, so a sandboxed agent gets a real toast too.",
    positionals: ["title", "body"]
  },
  {
    verb: "hook",
    usage: "hook <event>",
    summary: `TET's own plumbing: an agent's hook reports a turn (${HOOK_EVENTS.join("|")}). Not for you to call.`,
    positionals: ["event"],
    stdin: true,
    stdout: true
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
