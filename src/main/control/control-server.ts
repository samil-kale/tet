import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import { stripAnsi } from "../../shared/ansi";
import { CONTROL_VERBS, HELP_VERB, HOOK_EVENTS } from "../../shared/control";
import type { ControlErrorCode, ControlEvent, ControlRequest, ControlResponse, HookEvent } from "../../shared/control";
import { THEMES, themeKey } from "../../shared/themes";
import { COLOR_SCHEMES, PROMPT_IDS, TERMINAL_STATUSES } from "../../shared/types";
import type {
  AddRepositoryResult,
  AgentId,
  AppSettings,
  EditorListing,
  EditorReport,
  ExplorerListing,
  NoticeReport,
  Project,
  ProjectCommand,
  RepositoryState,
  TerminalDescriptor
} from "../../shared/types";
import { TET_SYSTEM_PROMPT } from "../agents/system-prompt";
import { tabControlToken } from "./control-token";

/**
 * Handed over by main.ts, not imported: no electron or node-pty here, so test/control.test.ts runs
 * the server under plain node with these faked. The same singletons ipc.ts holds: a second
 * transport onto that logic, never a second implementation (projects.ts's addProject/removeProject).
 */
export interface ControlDeps {
  version: string;
  /** Lets a test tell that restart-app replaced the process. */
  pid: number;
  store: {
    list(): Project[];
    get(projectId: string): Project | undefined;
  };
  settings: {
    get(): AppSettings;
    save(settings: AppSettings): void;
  };
  sessions: {
    get(projectId: string): ControlTerminals | undefined;
  };
  repositories: {
    get(projectId: string): { getState(): RepositoryState; listExplorer(): Promise<ExplorerListing> } | undefined;
  };
  /** See ControlRecords. */
  records: {
    editor(projectId: string): EditorReport | undefined;
    editors(projectId: string): EditorListing[];
    notices(): NoticeReport[];
    output(projectId: string, tabId: string): string | undefined;
  };
  /** `--user-data-dir` given — see ControlVerb.ownProfileOnly. */
  ownProfile: boolean;
  /** Opens a file in the project's preview tab, or a kept tab, and brings it to the front. */
  openEditor(projectId: string, path: string, keep: boolean): void;
  /** The active editor tab's text, asked of the window live — the one thing not kept as a report
   *  (see EditorReport). */
  editorContent(projectId: string): Promise<string | undefined>;
  /** The requirements dialog's answer, by id. */
  listAgents(): Promise<{ id: AgentId; name: string; installed: boolean }[]>;
  /** `AGENTS`' ids, so a new agent needs nothing here. */
  agentIds: readonly string[];
  addProject(directory: string): Promise<AddRepositoryResult>;
  removeProject(projectId: string): void;
  readCommands(root: string): Promise<ProjectCommand[]>;
  /** main.ts's teardown: ends every session and quits, optionally relaunching. */
  shutdown(relaunch: boolean): void;
  /** Its process starts with the first resize that draws it. */
  showTab(projectId: string, tabId: string): void;
  /** Tells the window which project to activate or forget. */
  projectsChanged(change: { added?: string; removed?: string }): void;
  /** A desktop toast from this process, which holds the desktop session (a sandboxed hook has
   *  none). Must never throw: `hook` toasts on the way to answering a turn. A click brings
   *  `target` to the front. */
  notify(title: string, body: string, target?: ToastTarget): void;
  /** main.ts's `applyTheme`: returns whether a restart is still needed. */
  applyTheme(): boolean;
}

export interface ToastTarget {
  projectId: string;
  tabId: string;
}

/** See ControlTerminals.hookEvent. */
export interface HookToast {
  title: string;
  body: string;
}

export interface HookOutcome {
  /** None where the notification settings say so. */
  toast?: HookToast;
}

/** A `tabs-list` entry: the window's descriptor plus what only the session manager knows. */
export interface InspectedTab extends TerminalDescriptor {
  /** The session this tab's hooks named, claimed or not. */
  reportedSessionId?: string;
  sandbox?: string;
}

/** The slice of ProjectSessionManager the verbs use. */
export interface ControlTerminals {
  snapshot(): TerminalDescriptor[];
  inspect(): InspectedTab[];
  /** At the last fitted size or a default; false unless the tab awaits its first start. */
  start(tabId: string): boolean;
  /** False for a tab that neither stopped nor failed to start. */
  restart(tabId: string): boolean;
  write(tabId: string, data: string): void;
  /** Oldest first. */
  events(): ControlEvent[];
  createTab(agentId: AgentId): TerminalDescriptor;
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined;
  closeTabs(tabIds: string[]): Promise<void>;
  renameTab(tabId: string, title: string): Promise<void>;
  /** `at` is when the hook fired, not arrived (ControlRequest.at). An unknown tab is no error: it
   *  may have closed while its CLI ended the turn. */
  hookEvent(tabId: string, event: HookEvent, payload: string, at: number | undefined): HookOutcome;
}

class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** `after` runs once the response reached the CLI: a verb ending the caller's process must reply
 *  first, or the CLI dies with an empty stdout. */
interface Answer {
  result: unknown;
  after?: () => void;
}

type Handler = (
  args: Record<string, unknown>,
  caller: ControlRequest["caller"],
  /** See ControlRequest.at. */
  at: number | undefined,
  /** Aborted once the CLI is gone (Ctrl+C) before its answer: nothing waits for it any more. */
  gone: AbortSignal
) => Promise<Answer> | Answer;

function text(args: Record<string, unknown>, name: string, what: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new ControlError("bad_args", `missing ${what}`);
  }
  return value;
}

/** A positive integer flag, or `fallback` when absent. */
function count(args: Record<string, unknown>, name: string, fallback: number): number {
  if (args[name] === undefined) {
    return fallback;
  }
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ControlError("bad_args", `--${name} takes a positive whole number`);
  }
  return value;
}

/** Strips escape sequences; CRLF to LF. */
function plainText(data: string): string {
  return stripAnsi(data).replace(/\r\n/g, "\n");
}

/**
 * A tab's output with its lines as finally shown: each keeps what follows its last bare `\r`, so a
 * progress bar's redraws leave one line. Over the whole output at once, a redraw split across
 * chunks included; the `\r` of a `\r\n` not yet complete is no redraw.
 */
function shownText(data: string): string {
  return plainText(data)
    .replace(/\r$/, "")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** `tabs-wait` default timeout and poll interval. */
const WAIT_TIMEOUT_S = 30;
const WAIT_POLL_MS = 100;
/** `events-tail` default. */
const EVENTS_TAIL = 50;
/** `tabs-output` default. */
const OUTPUT_KB = 16;

/**
 * What a hook prints back into its agent. `{}` rather than nothing: Codex parses its Stop hook's
 * stdout as JSON, and every agent takes JSON on hook channels not appended to the prompt
 * (measured). `prompt-submit`'s stdout would be appended to the prompt: "". `session-start`
 * carries TET's system prompt as added context, appended to the user's instructions (measured,
 * Codex 0.154.0: in the first turn, and again on `resume`).
 */
const HOOK_STDOUT: Record<HookEvent, string> = {
  "session-start": JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: TET_SYSTEM_PROMPT }
  }),
  "prompt-submit": "",
  stop: "{}",
  permission: "{}",
  question: "{}",
  idle: "{}"
};

const DYNAMIC_PORT_START = 49152;
const DYNAMIC_PORT_RANGE = 65535 - DYNAMIC_PORT_START;

/** The preferred port for this data folder, before checking it is free. */
function hashPort(dataRoot: string): number {
  const hash = crypto.createHash("sha1").update(dataRoot).digest("hex");
  return DYNAMIC_PORT_START + (parseInt(hash.slice(0, 8), 16) % DYNAMIC_PORT_RANGE);
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/**
 * Derived from the data folder (data-root.ts), so two accounts, or a test profile beside the tet it
 * runs in, get ports of their own. Probed by binding: Windows excludes dynamic-range pieces for
 * Hyper-V/WSL/Docker NAT (`netsh int ipv4 show excludedportrange`), failing with `EACCES` — static
 * enough to reuse the probed port. Not OS-assigned: the port must be in every terminal's
 * environment (setControlEnv) before the server starts.
 */
export async function findControlPort(dataRoot: string): Promise<number> {
  const start = hashPort(dataRoot);
  for (let offset = 0; offset < DYNAMIC_PORT_RANGE; offset += 1) {
    const port = DYNAMIC_PORT_START + ((start - DYNAMIC_PORT_START + offset) % DYNAMIC_PORT_RANGE);
    if (await canBind(port)) {
      return port;
    }
  }
  throw new Error("no free loopback port in the dynamic range");
}

function verbs(deps: ControlDeps): Record<string, Handler> {
  const { store, settings, sessions } = deps;

  const project = (args: Record<string, unknown>, caller: ControlRequest["caller"]): Project => {
    const id = typeof args.project === "string" && args.project ? args.project : caller.projectId;
    if (!id) {
      throw new ControlError("bad_args", "no project: pass --project <id> (see projects-list)");
    }
    const found = store.get(id);
    if (!found) {
      throw new ControlError("not_found", `unknown project: ${id}`);
    }
    return found;
  };

  const terminals = (found: Project): ControlTerminals => {
    const manager = sessions.get(found.id);
    if (!manager) {
      throw new ControlError("internal", `project ${found.id} has no terminals`);
    }
    return manager;
  };

  /** A tab id checked to exist, with its project and terminals. */
  const knownTab = (
    args: Record<string, unknown>,
    caller: ControlRequest["caller"]
  ): { tabs: ControlTerminals; tabId: string; found: Project; tab: TerminalDescriptor } => {
    const found = project(args, caller);
    const tabId = text(args, "tabId", "tab id");
    const tabs = terminals(found);
    const tab = tabs.snapshot().find((entry) => entry.tabId === tabId);
    if (!tab) {
      throw new ControlError("not_found", `unknown tab: ${tabId} (see tabs-list)`);
    }
    return { tabs, tabId, found, tab };
  };

  return {
    version: () => ({ result: { version: deps.version, pid: deps.pid } }),

    "list-themes": () => ({ result: THEMES.map(({ id, label, kind }) => ({ id, label, kind })) }),

    "list-agents": async () => ({ result: await deps.listAgents() }),

    "settings-get": () => ({ result: settings.get() }),

    "settings-set-theme": (args) => {
      const id = text(args, "theme", "theme id");
      // The store keeps any string and silently falls back (settings.ts); refuse it here instead.
      const theme = THEMES.find((candidate) => candidate.id === id);
      if (!theme) {
        throw new ControlError("bad_args", `unknown theme: ${id} (see list-themes)`);
      }
      settings.save({ ...settings.get(), [themeKey(theme.kind)]: id });
      // Shown at once if the window is in that kind. The flag is for the agent to relay; restarting
      // is the user's call.
      return { result: { saved: true, restartRequired: deps.applyTheme() } };
    },

    "settings-set-color-scheme": (args) => {
      const value = text(args, "scheme", "color scheme");
      const colorScheme = COLOR_SCHEMES.find((candidate) => candidate === value);
      if (!colorScheme) {
        throw new ControlError("bad_args", `unknown color scheme: ${value} (one of ${COLOR_SCHEMES.join(", ")})`);
      }
      settings.save({ ...settings.get(), colorScheme });
      // A kind the window is not drawn in waits for a restart (main.ts's applyTheme).
      return { result: { saved: true, restartRequired: deps.applyTheme() } };
    },

    "settings-set-prompt": (args) => {
      const id = text(args, "id", "prompt id");
      if (!PROMPT_IDS.some((candidate) => candidate === id)) {
        throw new ControlError("bad_args", `unknown prompt: ${id} (one of ${PROMPT_IDS.join(", ")})`);
      }
      // No text resets: "" means tet's own prompt, read by ipc.ts when asking.
      const value = args.text;
      const current = settings.get();
      settings.save({ ...current, prompts: { ...current.prompts, [id]: typeof value === "string" ? value : "" } });
      return { result: { saved: true } };
    },

    "projects-list": () => ({ result: store.list() }),

    "repo-state": (args, caller) => {
      const found = project(args, caller);
      const repository = deps.repositories.get(found.id);
      if (!repository) {
        throw new ControlError("internal", `project ${found.id} has no repository`);
      }
      return { result: repository.getState() };
    },

    "projects-add": async (args) => {
      const added = await deps.addProject(text(args, "path", "path"));
      if (!added.project) {
        throw new ControlError("bad_args", added.error ?? "could not open the folder");
      }
      deps.projectsChanged({ added: added.project.id });
      return { result: added.project };
    },

    "projects-remove": (args, caller) => {
      const id = text(args, "projectId", "project id");
      if (!store.get(id)) {
        throw new ControlError("not_found", `unknown project: ${id}`);
      }
      const remove = (): void => {
        deps.removeProject(id);
        deps.projectsChanged({ removed: id });
      };
      // The caller's own project takes the caller's tab with it — answer first.
      if (id === caller.projectId) {
        return { result: { removed: id }, after: remove };
      }
      remove();
      return { result: { removed: id } };
    },

    "tabs-list": (args, caller) => ({ result: terminals(project(args, caller)).inspect() }),

    "tabs-start": (args, caller) => {
      const { tabs, tabId } = knownTab(args, caller);
      if (!tabs.start(tabId)) {
        throw new ControlError("bad_args", `tab ${tabId} is not waiting for its first start (see tabs-list; tabs-restart for one that stopped)`);
      }
      return { result: { started: tabId } };
    },

    "tabs-restart": (args, caller) => {
      const { tabs, tabId } = knownTab(args, caller);
      if (!tabs.restart(tabId)) {
        throw new ControlError("bad_args", `tab ${tabId} has nothing to restart: it neither stopped nor failed to start (see tabs-list)`);
      }
      return { result: { restarted: tabId } };
    },

    "tabs-wait": async (args, caller, _at, gone) => {
      const { tabs, tabId } = knownTab(args, caller);
      const status = args.status;
      const conditions: [string, (tab: InspectedTab) => boolean][] = [];
      if (args.session === true) {
        conditions.push(["bound to a session", (tab) => tab.sessionId !== undefined]);
      }
      if (args.busy === true) {
        conditions.push(["working a turn", (tab) => tab.busy === true]);
      }
      if (args.idle === true) {
        conditions.push(["idle", (tab) => tab.busy !== true]);
      }
      if (typeof status === "string") {
        if (!TERMINAL_STATUSES.some((candidate) => candidate === status)) {
          throw new ControlError("bad_args", `unknown status: ${status} (one of ${TERMINAL_STATUSES.join(", ")})`);
        }
        conditions.push([status, (tab) => tab.status === status]);
      }
      if (conditions.length === 0) {
        throw new ControlError("bad_args", "nothing to wait for: pass --session, --busy, --idle or --status <status>");
      }
      const deadline = Date.now() + count(args, "timeout", WAIT_TIMEOUT_S) * 1000;
      while (!gone.aborted) {
        const tab = tabs.inspect().find((candidate) => candidate.tabId === tabId);
        if (!tab) {
          throw new ControlError("not_found", `tab ${tabId} was closed while waiting`);
        }
        if (conditions.every(([, holds]) => holds(tab))) {
          return { result: tab };
        }
        if (Date.now() >= deadline) {
          const missing = conditions.filter(([, holds]) => !holds(tab)).map(([what]) => what);
          throw new ControlError("timeout", `tab ${tabId} is still not ${missing.join(" and not ")} (status ${tab.status})`);
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      }
      // Answered to no one.
      throw new ControlError("timeout", `stopped waiting for tab ${tabId}: the caller is gone`);
    },

    "tabs-send": (args, caller) => {
      const { tabs, tabId } = knownTab(args, caller);
      const value = args.text;
      if (typeof value !== "string" && args.enter !== true) {
        throw new ControlError("bad_args", "missing text (or --enter for Enter alone)");
      }
      tabs.write(tabId, `${typeof value === "string" ? value : ""}${args.enter === true ? "\r" : ""}`);
      return { result: { sent: tabId } };
    },

    "tabs-output": (args, caller) => {
      const { tabId, found } = knownTab(args, caller);
      const output = shownText(deps.records.output(found.id, tabId) ?? "");
      return { result: { output: output.slice(-count(args, "kb", OUTPUT_KB) * 1024) } };
    },

    "events-tail": (args, caller) => ({
      result: terminals(project(args, caller)).events().slice(-count(args, "tail", EVENTS_TAIL))
    }),

    "editor-open": (args, caller) => {
      const found = project(args, caller);
      const filePath = text(args, "path", "path");
      const keep = args.keep === true;
      deps.openEditor(found.id, filePath, keep);
      return { result: { opened: filePath, keep } };
    },

    "editor-state": async (args, caller) => {
      const found = project(args, caller);
      const report = deps.records.editor(found.id);
      return { result: report ? { ...report, content: await deps.editorContent(found.id) } : null };
    },

    "editor-list": (args, caller) => ({ result: deps.records.editors(project(args, caller).id) }),

    "explorer-list": async (args, caller) => {
      const found = project(args, caller);
      const repository = deps.repositories.get(found.id);
      if (!repository) {
        throw new ControlError("internal", `project ${found.id} has no repository`);
      }
      return { result: await repository.listExplorer() };
    },

    "notices-list": () => ({ result: deps.records.notices() }),

    "tabs-create": (args, caller) => {
      const found = project(args, caller);
      const agent = text(args, "agent", "agent: pass --agent <id> (see list-agents)");
      if (!deps.agentIds.includes(agent)) {
        throw new ControlError("bad_args", `unknown agent: ${agent} (see list-agents)`);
      }
      const tab = terminals(found).createTab(agent as AgentId);
      deps.showTab(found.id, tab.tabId);
      return { result: tab };
    },

    "tabs-run-command": async (args, caller) => {
      const found = project(args, caller);
      const name = text(args, "name", "command name");
      const commands = await deps.readCommands(found.path);
      // By name or by the line itself — an agent reading tet.json may hold either.
      const command = commands.find((candidate) => candidate.name === name || candidate.command === name);
      if (!command) {
        throw new ControlError("not_found", `no saved command named ${name} in ${found.name}'s tet.json`);
      }
      const tab = terminals(found).createCommandTab(command);
      if (!tab) {
        // createCommandTab already showed a notice saying why.
        throw new ControlError("bad_args", `${name} cannot be run without a shell — see the notice in TET`);
      }
      deps.showTab(found.id, tab.tabId);
      return { result: tab };
    },

    "tabs-close": (args, caller) => {
      const { tabs, tabId, found } = knownTab(args, caller);
      const close = (): void => void tabs.closeTabs([tabId]);
      // Closing the tab the CLI runs in kills the CLI — answer first.
      if (found.id === caller.projectId && tabId === caller.tabId) {
        return { result: { closed: tabId }, after: close };
      }
      close();
      return { result: { closed: tabId } };
    },

    "tabs-rename": async (args, caller) => {
      const { tabs, tabId } = knownTab(args, caller);
      await tabs.renameTab(tabId, text(args, "title", "title"));
      return { result: { renamed: tabId } };
    },

    "restart-app": (args) => {
      if (args.confirm !== true) {
        throw new ControlError(
          "bad_args",
          "restart-app ends every terminal in every open project, this one included. Ask the user, then pass --confirm."
        );
      }
      return { result: { restarting: true }, after: () => deps.shutdown(true) };
    },

    notify: (args, caller) => {
      const body = args.body;
      // From one of tet's terminals, the toast is about that tab.
      const target = caller.projectId && caller.tabId ? { projectId: caller.projectId, tabId: caller.tabId } : undefined;
      deps.notify(text(args, "title", "title"), typeof body === "string" ? body : "", target);
      return { result: { notified: true } };
    },

    hook: (args, caller, at) => {
      const event = text(args, "event", "hook event");
      if (!HOOK_EVENTS.some((candidate) => candidate === event)) {
        throw new ControlError("bad_args", `unknown hook event: ${event} (one of ${HOOK_EVENTS.join(", ")})`);
      }
      if (!caller.tabId) {
        throw new ControlError("bad_args", "a hook reports for the tab it runs in, and this is not one");
      }
      const payload = typeof args.payload === "string" ? args.payload : "";
      // The caller's own, never `--project`: the token vouches for its tab in its project only, and
      // tab ids like `new-1` repeat across projects.
      const where = project({}, caller);
      const outcome = terminals(where).hookEvent(caller.tabId, event as HookEvent, payload, at);
      if (outcome.toast) {
        deps.notify(outcome.toast.title, outcome.toast.body, { projectId: where.id, tabId: caller.tabId });
      }
      return { result: { stdout: HOOK_STDOUT[event as HookEvent] } };
    }
  };
}

function reject(code: ControlErrorCode, message: string): ControlResponse {
  return { ok: false, error: { code, message } };
}

/** A tet-ctl writes its request at once. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The server `tet-ctl` talks to: one POST per connection on 127.0.0.1. HTTP, not raw TCP, because
 * a sandbox reaches `host.docker.internal` through sbx's HTTP-only proxy (measured: raw TCP
 * connects but no bytes arrive; curl works). Every request must carry this run's token from
 * main.ts, or its tab's token for the caller ids it names (control-token.ts), else `unauthorized`.
 */
export async function startControlServer(
  deps: ControlDeps,
  token: string,
  port: number
): Promise<{ close: () => Promise<void> }> {
  const handlers = verbs(deps);

  const handle = async (
    request: ControlRequest,
    gone: AbortSignal
  ): Promise<{ response: ControlResponse; after?: () => void }> => {
    const caller: ControlRequest["caller"] = {
      projectId: typeof request.caller?.projectId === "string" ? request.caller.projectId : undefined,
      tabId: typeof request.caller?.tabId === "string" ? request.caller.tabId : undefined
    };
    // A caller's ids count only with the token made for them; the run's own token speaks for no
    // tab, and no terminal has it (control-token.ts).
    const expected = Buffer.from(
      caller.projectId === undefined && caller.tabId === undefined
        ? token
        : tabControlToken(token, caller.projectId ?? "", caller.tabId ?? "")
    );
    const given = Buffer.from(typeof request.token === "string" ? request.token : "");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return { response: reject("unauthorized", "not a terminal of this TET") };
    }
    const handler =
      request.verb !== HELP_VERB && CONTROL_VERBS.some((entry) => entry.verb === request.verb)
        ? handlers[request.verb]
        : undefined;
    if (!handler) {
      return { response: reject("unknown_verb", `unknown verb: ${String(request.verb)} (see tet-ctl help)`) };
    }
    if (!deps.ownProfile && CONTROL_VERBS.some((entry) => entry.verb === request.verb && entry.ownProfileOnly)) {
      return {
        response: reject("unauthorized", `${request.verb} only answers in a TET started with a profile of its own (--user-data-dir)`)
      };
    }
    if (CONTROL_VERBS.some((entry) => entry.verb === request.verb && entry.ownProjectOnly)) {
      const own = caller.projectId;
      const asked = request.args?.project;
      if (!own || (typeof asked === "string" && asked !== "" && asked !== own)) {
        return { response: reject("unauthorized", `${request.verb} only answers for a tab of the caller's own project`) };
      }
    }
    try {
      const answer = await handler(request.args ?? {}, caller, request.at, gone);
      return { response: { ok: true, result: answer.result }, after: answer.after };
    } catch (error) {
      if (error instanceof ControlError) {
        return { response: reject(error.code, error.message) };
      }
      return { response: reject("internal", error instanceof Error ? error.message : String(error)) };
    }
  };

  const respond = (res: http.ServerResponse, response: ControlResponse, after?: () => void): void => {
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    if (after) {
      // `close` means flushed and disconnected, not merely handed to the OS.
      res.once("close", after);
    }
    res.end(JSON.stringify(response) + "\n");
  };

  const server = http.createServer({ requestTimeout: REQUEST_TIMEOUT_MS }, (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Connection: "close" }).end();
      return;
    }
    req.setEncoding("utf8");
    let body = "";
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      let request: ControlRequest;
      try {
        request = JSON.parse(body) as ControlRequest;
      } catch {
        respond(res, reject("bad_args", "not a JSON request"));
        return;
      }
      // A non-object would throw inside `handle`, leaving the connection unanswered.
      if (typeof request !== "object" || request === null || Array.isArray(request)) {
        respond(res, reject("bad_args", "not a JSON request"));
        return;
      }
      // A response closed before it ended is a caller gone mid-answer (Ctrl+C on a waiting CLI).
      const gone = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded) {
          gone.abort();
        }
      });
      void handle(request, gone.signal).then(({ response, after }) => respond(res, response, after));
    });
    req.on("error", () => undefined);
    // A response write failing after hand-over (CLI gone, reset, or this process exiting) is
    // otherwise an uncaught exception, e.g. `write EAGAIN`.
    res.on("error", () => undefined);
  });

  // The OS reclaims a killed run's port, so EADDRINUSE means another tet is listening: let it surface.
  await bind(server, port);

  return {
    // closeAllConnections (Node 18.2+): else an unfinished request holds server.close() open forever.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

function bind(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
