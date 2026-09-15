import { PROMPT_IDS } from "./types";

/**
 * The control channel's wire contract, shared by the server (`src/main/control/control-server.ts`)
 * and the `tet-ctl` CLI (`src/cli/tet-ctl.ts`). Nothing here imports electron or node: the CLI is
 * bundled on its own and must stay a plain script.
 *
 * One HTTP POST per connection: a JSON body in, a JSON body out, then the server ends the
 * connection. No ids, no pipelining — the CLI is one process per invocation.
 */

/** The environment every pty tet spawns carries; the CLI reads its whole configuration off it. */
export const CONTROL_ENV = {
  port: "TET_CONTROL_PORT",
  token: "TET_CONTROL_TOKEN",
  projectId: "TET_PROJECT_ID",
  tabId: "TET_TAB_ID",
  /** Unset for every ordinary pty, so tet-ctl.ts falls back to "127.0.0.1". Only an sbx-wrapped
   *  session carries this, set to "host.docker.internal" — the sandbox has its own loopback. See
   *  sbx.ts's isControlChannelAllowed for the policy-allow this also requires. */
  host: "TET_CONTROL_HOST"
} as const;

export type ControlErrorCode = "unauthorized" | "unknown_verb" | "bad_args" | "not_found" | "internal" | "timeout";

export interface ControlRequest {
  token: string;
  verb: string;
  args: Record<string, unknown>;
  /** The tab the CLI was run from, off its environment — what "the project" means when no
   *  `--project` was given, and what a verb must answer *before* acting on, if it is the target. */
  caller: { projectId?: string; tabId?: string };
  /**
   * When the caller spoke, by its own clock — what a turn signal is *ordered* by, since two
   * hooks of the same turn are two requests racing each other and the one that arrives second
   * is not always the one that happened second. Every report about one tab comes from the same
   * place (that tab's agent, host or sandbox), so one clock decides throughout.
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
  /** The names the CLI gives its positional arguments, in order; flags go in under their own name
   *  (CONTROL_FLAGS). */
  positionals: string[];
  /**
   * Only for a run with a profile of its own (`--user-data-dir`, as the tests start tet): the verb
   * types into another agent's terminal or reads what it printed, which in an ordinary run would
   * let one agent drive or overhear another.
   */
  ownProfileOnly?: true;
  /** Sends whatever the caller wrote to stdin as `args.payload` — an agent's hook payload. */
  stdin?: true;
  /**
   * The answer is text for the calling agent rather than a result for a person: the CLI writes
   * `result.stdout` verbatim and nothing else, and never fails the caller — a hook exiting
   * non-zero can hold back the very prompt it was reporting.
   */
  stdout?: true;
}

/**
 * What an agent's hook reports, in tet's own vocabulary rather than any CLI's: each agent's
 * setup maps its own events onto these (each agent's own hooks.ts), and the session manager
 * gives all of them the same meaning. `permission` and `question` are one mark with two toasts —
 * the wording is the only difference, and it belongs where the event is named.
 */
export const HOOK_EVENTS = ["prompt-submit", "stop", "permission", "question", "idle"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The flags the CLI knows, by name: a switch is `true` when given, a value flag takes the next
 *  argument as a string. Every verb gets all of them; each reads the ones it has a use for. */
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
  timeout: "value"
};

/** What `events-tail` lists: what the session manager heard and made of it, in arrival order. */
export interface ControlEvent {
  /** When it arrived here, ms since epoch. */
  at: number;
  tabId: string;
  /** A hook report arrived; a tab took a reported session as its own (reconcile); a tab was closed. */
  kind: "hook" | "claimed" | "closed";
  /** The hook's event, for `hook`. */
  event?: HookEvent;
  /** When the hook fired by the agent's own clock (ControlRequest.at), for `hook`. */
  reportedAt?: number;
  /** The session the report named, or the one claimed. */
  sessionId?: string;
}

/** Every verb, with the one line `tet-ctl help` prints for it. The CLI answers `help` by itself; the
 *  server refuses anything not in this list as `unknown_verb`. */
export const CONTROL_VERBS: ReadonlyArray<ControlVerb> = [
  { verb: "help", usage: "help", summary: "Print this list.", positionals: [] },
  { verb: "version", usage: "version", summary: "TET's version.", positionals: [] },
  { verb: "list-themes", usage: "list-themes", summary: "The color themes (id and label).", positionals: [] },
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
    summary: "Set the color theme. Applies after TET is restarted — tell the user, do not restart for them.",
    positionals: ["theme"]
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
    usage: "tabs-wait <tab-id> [--session] [--busy] [--idle] [--status <status>] [--timeout <seconds>] [--project <id>]",
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
    verb: "tabs-output",
    usage: "tabs-output <tab-id> [--tail <chars>] [--project <id>]",
    summary: "What a tab printed lately, escape sequences taken out. Only in a run with its own --user-data-dir.",
    positionals: ["tabId"],
    ownProfileOnly: true
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

/** The verb the CLI answers itself. */
export const HELP_VERB = "help";

/** What `tet-ctl` exits with; an agent can branch on these without parsing anything. */
export const EXIT_CODES = {
  ok: 0,
  internal: 1,
  unauthorized: 2,
  usage: 3,
  /** `tabs-wait` gave up. */
  timeout: 4
} as const;
