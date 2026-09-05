/**
 * The control channel's wire contract, shared by the server in the main process
 * (`src/main/control/control-server.ts`) and the `tet-ctl` CLI (`src/cli/tet-ctl.ts`) the same way
 * `api.ts` is shared by the main process and the renderer. Nothing here imports electron or
 * node: the CLI is bundled on its own and must stay a plain script.
 *
 * One request per connection: a single JSON line in, a single JSON line out, then the server
 * ends the connection. No ids, no pipelining — the CLI is one process per invocation.
 */

/** The environment every pty tet spawns carries; the CLI reads its whole configuration off it. */
export const CONTROL_ENV = {
  port: "TET_CONTROL_PORT",
  token: "TET_CONTROL_TOKEN",
  projectId: "TET_PROJECT_ID",
  tabId: "TET_TAB_ID"
} as const;

export type ControlErrorCode = "unauthorized" | "unknown_verb" | "bad_args" | "not_found" | "internal";

export interface ControlRequest {
  token: string;
  verb: string;
  args: Record<string, unknown>;
  /** The tab the CLI was run from, off its environment — what "the project" means when no
   *  `--project` was given, and what a verb must answer *before* acting on, if it is the target. */
  caller: { projectId?: string; tabId?: string };
}

export type ControlResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: ControlErrorCode; message: string } };

export interface ControlVerb {
  verb: string;
  usage: string;
  summary: string;
  /** The names the CLI gives its positional arguments, in order; `--project`, `--agent` and
   *  `--confirm` are flags and go in as `project`, `agent` and `confirm`. */
  positionals: string[];
}

/**
 * Every verb, with the one line `tet-ctl help` prints for it. The CLI answers `help` by itself,
 * so an agent learns the surface even while tet is not listening; the server refuses anything
 * not in this list as `unknown_verb`. `[--project <id>]` left out means the tab's own project.
 */
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
    summary: "A project's terminal tabs and their state.",
    positionals: []
  },
  {
    verb: "tabs-create",
    usage: "tabs-create --agent <claude|opencode|codex|shell> [--project <id>]",
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
  }
];

/** The verb the CLI answers itself. */
export const HELP_VERB = "help";

/** What `tet-ctl` exits with; an agent can branch on these without parsing anything. */
export const EXIT_CODES = {
  ok: 0,
  internal: 1,
  unauthorized: 2,
  usage: 3
} as const;
