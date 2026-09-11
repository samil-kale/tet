import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import { CONTROL_VERBS, HELP_VERB, HOOK_EVENTS } from "../../shared/control";
import type { ControlErrorCode, ControlRequest, ControlResponse, HookEvent } from "../../shared/control";
import { SYSTEM_THEME_ID, THEMES } from "../../shared/themes";
import { PROMPT_IDS } from "../../shared/types";
import type {
  AddRepositoryResult,
  AgentId,
  AppSettings,
  Project,
  ProjectCommand,
  RepositoryState,
  TerminalDescriptor
} from "../../shared/types";

/**
 * What the control channel acts on, handed over by main.ts rather than imported: nothing here
 * reaches for electron or node-pty, so the server runs under plain node with these faked — how
 * test/control.test.ts drives it, through the real CLI.
 */
export interface ControlDeps {
  version: string;
  /** Answered with the version: what a test started tet by is gone after restart-app. */
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
    get(projectId: string): { getState(): RepositoryState } | undefined;
  };
  /** Every agent, and whether it is installed — the requirements dialog's answer, by id. */
  listAgents(): Promise<{ id: AgentId; name: string; installed: boolean }[]>;
  /** The ids `tabs-create` accepts — `AGENTS`', so a fourth agent needs nothing here. */
  agentIds: readonly string[];
  addProject(directory: string): Promise<AddRepositoryResult>;
  removeProject(projectId: string): void;
  readCommands(root: string): Promise<ProjectCommand[]>;
  /** Ends every session and quits, relaunching first when asked — main.ts's teardown. */
  shutdown(relaunch: boolean): void;
  /** Brings a tab to the front — its process starts with the first resize that draws it. */
  showTab(projectId: string, tabId: string): void;
  /** Tells the window the project list changed under it, and which entry to activate or forget. */
  projectsChanged(change: { added?: string; removed?: string }): void;
  /** Shows a real desktop notification from this process, the one holding the desktop session. A
   *  sandboxed hook has none, so its report is toasted here instead. Fire-and-forget, and it must
   *  never throw: `hook` shows its toast on the way to answering, and that answer is a turn.
   *  `target` is the tab it is about, which a click on it brings to the front. */
  notify(title: string, body: string, target?: ToastTarget): void;
}

/** Which tab a toast is about. */
export interface ToastTarget {
  projectId: string;
  tabId: string;
}

/** What a hook's report leaves for the server to do — see ControlTerminals.hookEvent. */
export interface HookToast {
  title: string;
  body: string;
}

export interface HookOutcome {
  /** What the reporting agent is to see on the hook's stdout; the verb's own default otherwise. */
  stdout?: string;
  /** The toast to show, or nothing where the notification settings say so. */
  toast?: HookToast;
}

/** The slice of ProjectSessionManager the verbs use. */
export interface ControlTerminals {
  snapshot(): TerminalDescriptor[];
  createTab(agentId: AgentId): TerminalDescriptor;
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined;
  closeTabs(tabIds: string[]): Promise<void>;
  renameTab(tabId: string, title: string): Promise<void>;
  /** A turn reported by one tab's own agent hook, `at` being when the hook fired rather than
   *  when it arrived (ControlRequest.at). An unknown tab is not an error — the tab can have been
   *  closed while its CLI was still ending its turn. */
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

/** A verb's answer. `after` runs once the response has reached the CLI: a verb that ends the
 *  caller's own process must get the reply out first, or the CLI dies with an empty stdout. */
interface Answer {
  result: unknown;
  after?: () => void;
}

type Handler = (
  args: Record<string, unknown>,
  caller: ControlRequest["caller"],
  /** When the caller spoke — see ControlRequest.at. */
  at: number | undefined
) => Promise<Answer> | Answer;

function text(args: Record<string, unknown>, name: string, what: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new ControlError("bad_args", `missing ${what}`);
  }
  return value;
}

const DYNAMIC_PORT_START = 49152;
const DYNAMIC_PORT_RANGE = 65535 - DYNAMIC_PORT_START;

/** Where userData alone would put the port, before checking it is actually free. */
function hashPort(userDataPath: string): number {
  const hash = crypto.createHash("sha1").update(userDataPath).digest("hex");
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
 * The port the control server will listen on, derived from userData so a dev checkout and the
 * installed app, or two Windows accounts, each land on a port of their own. Bound and released
 * here rather than trusted outright: Windows carves pieces out of the dynamic range for
 * Hyper-V/WSL/Docker NAT (`netsh int ipv4 show excludedportrange`), and a bind into one fails with
 * `EACCES`, not `EADDRINUSE` — static enough that reusing the probed port at the real bind is
 * reliable. Probed rather than assigned by the OS because the port has to be in every terminal's
 * environment (setControlEnv) before the server starts.
 */
export async function findControlPort(userDataPath: string): Promise<number> {
  const start = hashPort(userDataPath);
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

  return {
    version: () => ({ result: { version: deps.version, pid: deps.pid } }),

    "list-themes": () => ({
      result: [
        { id: SYSTEM_THEME_ID, label: "System (whichever the OS is in)" },
        ...THEMES.map(({ id, label }) => ({ id, label }))
      ]
    }),

    "list-agents": async () => ({ result: await deps.listAgents() }),

    "settings-get": () => ({ result: settings.get() }),

    "settings-set-theme": (args) => {
      const theme = text(args, "theme", "theme id");
      // The store keeps any string (settings.ts); what it would silently fall back from is
      // refused here, where the caller can be told.
      if (theme !== SYSTEM_THEME_ID && !THEMES.some((candidate) => candidate.id === theme)) {
        throw new ControlError("bad_args", `unknown theme: ${theme} (see list-themes)`);
      }
      settings.save({ ...settings.get(), theme });
      // Never applied to the running window — xterm, shiki, monaco and the window chrome bake the
      // theme in at construction. The flag is for the agent to relay; restarting is the user's call.
      return { result: { saved: true, restartRequired: true } };
    },

    "settings-set-prompt": (args) => {
      const id = text(args, "id", "prompt id");
      if (!PROMPT_IDS.some((candidate) => candidate === id)) {
        throw new ControlError("bad_args", `unknown prompt: ${id} (one of ${PROMPT_IDS.join(", ")})`);
      }
      // No text is the reset: the store keeps "" for tet's own, and ipc.ts reads it when asking.
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

    "tabs-list": (args, caller) => ({ result: terminals(project(args, caller)).snapshot() }),

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
      // By the name the row shows or by the line itself — an agent reading tet.json may hold either.
      const command = commands.find((candidate) => candidate.name === name || candidate.command === name);
      if (!command) {
        throw new ControlError("not_found", `no saved command named ${name} in ${found.name}'s tet.json`);
      }
      const tab = terminals(found).createCommandTab(command);
      if (!tab) {
        // createCommandTab has already said why, as a notice in the window.
        throw new ControlError("bad_args", `${name} cannot be run without a shell — see the notice in TET`);
      }
      deps.showTab(found.id, tab.tabId);
      return { result: tab };
    },

    "tabs-close": (args, caller) => {
      const found = project(args, caller);
      const tabId = text(args, "tabId", "tab id");
      const tabs = terminals(found);
      if (!tabs.snapshot().some((tab) => tab.tabId === tabId)) {
        throw new ControlError("not_found", `unknown tab: ${tabId} (see tabs-list)`);
      }
      const close = (): void => void tabs.closeTabs([tabId]);
      // Closing the tab the CLI runs in kills the CLI — answer first.
      if (found.id === caller.projectId && tabId === caller.tabId) {
        return { result: { closed: tabId }, after: close };
      }
      close();
      return { result: { closed: tabId } };
    },

    "tabs-rename": async (args, caller) => {
      const found = project(args, caller);
      const tabId = text(args, "tabId", "tab id");
      await terminals(found).renameTab(tabId, text(args, "title", "title"));
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
      // A title alone is a notification; the body is for what does not fit in one. Every toast
      // tet composes itself has both, so only a caller of the verb ever leaves it out.
      const body = args.body;
      // Called from one of tet's own terminals, the toast is about that tab.
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
      const where = project(args, caller);
      const outcome = terminals(where).hookEvent(caller.tabId, event as HookEvent, payload, at);
      if (outcome.toast) {
        deps.notify(outcome.toast.title, outcome.toast.body, { projectId: where.id, tabId: caller.tabId });
      }
      // `{}` where the event has nothing to say, rather than nothing at all: Codex reads its Stop
      // hook's stdout as one JSON value, and every agent whose hooks tet registers takes JSON on
      // the channels it does not append to the prompt (measured — the toast's own result used to
      // land there). `prompt-submit` is the exception at both ends: its answer is the prompt's
      // own text, so having nothing to say there means saying nothing.
      return { result: { stdout: outcome.stdout ?? (event === "prompt-submit" ? "" : "{}") } };
    }
  };
}

function reject(code: ControlErrorCode, message: string): ControlResponse {
  return { ok: false, error: { code, message } };
}

/** How long a connection may sit without a full request line — a tet-ctl writes it at once. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The local server an agent's `tet-ctl` talks to — one POST per connection, on 127.0.0.1 for a
 * plain host terminal. HTTP, not a bare TCP socket with an NDJSON line, because that is the one
 * transport that also reaches this server from inside an sbx sandbox: a sandbox reaches
 * `host.docker.internal` through sbx's own proxy, and that proxy is HTTP-only — verified live, a
 * raw TCP echo server behind it accepted the connection but never saw a byte written to it, while
 * a plain `curl http://host.docker.internal:<port>` reached the same host process immediately.
 * Every request carries the token main.ts made for this run; anything else is answered
 * `unauthorized` and dropped.
 */
export async function startControlServer(
  deps: ControlDeps,
  token: string,
  port: number
): Promise<{ close: () => Promise<void> }> {
  const handlers = verbs(deps);
  const expected = Buffer.from(token);

  const handle = async (request: ControlRequest): Promise<{ response: ControlResponse; after?: () => void }> => {
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
    try {
      const answer = await handler(request.args ?? {}, request.caller ?? {}, request.at);
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
      // Only once the CLI has the answer: `close` is the response fully flushed and the connection
      // gone, not merely handed to the OS to send.
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
      void handle(request).then(({ response, after }) => respond(res, response, after));
    });
    req.on("error", () => undefined);
    // The response side needs the same, and for a sharper reason: a write failing *after* it was
    // handed over — the CLI gone, the connection reset, or this process leaving because the verb
    // it just answered ends it — surfaces as an uncaught exception, which would block the whole
    // app. Seen for real as `write EAGAIN` while the test suite drove a live instance.
    res.on("error", () => undefined);
  });

  // A TCP port leaves nothing behind for a killed run to hand over — the OS reclaims it the moment
  // the process is gone — so EADDRINUSE here only ever means another tet is genuinely listening.
  // Nothing to recover: bind once and let that error surface.
  await bind(server, port);

  return {
    // closeAllConnections (Node 18.2+): a client that connected and never finished its request
    // would otherwise hold server.close()'s callback open indefinitely.
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
