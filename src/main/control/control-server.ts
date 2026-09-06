import * as crypto from "node:crypto";
import * as net from "node:net";
import { CONTROL_VERBS, HELP_VERB } from "../../shared/control";
import type { ControlErrorCode, ControlRequest, ControlResponse } from "../../shared/control";
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
 * reaches for electron or node-pty, so the server runs under plain node with these faked —
 * which is how test/control.test.ts drives it, through the real CLI.
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
  readCommands(root: string): Promise<ProjectCommand[] | null>;
  /** Ends every session and quits, relaunching first when asked — main.ts's teardown. */
  shutdown(relaunch: boolean): void;
  /** Brings a tab to the front — its process starts with the first resize that draws it. */
  showTab(projectId: string, tabId: string): void;
  /** Tells the window the project list changed under it, and which entry to activate or forget. */
  projectsChanged(change: { added?: string; removed?: string }): void;
}

/** The slice of ProjectSessionManager the verbs use. */
export interface ControlTerminals {
  snapshot(): TerminalDescriptor[];
  createTab(agentId: AgentId): TerminalDescriptor;
  createCommandTab(command: ProjectCommand): TerminalDescriptor | undefined;
  closeTabs(tabIds: string[]): Promise<void>;
  renameTab(tabId: string, title: string): Promise<void>;
}

class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * A verb's answer. `after` runs once the response has reached the CLI: for the verbs that end
 * the caller's own process (closing its tab, its project, or the whole app) the reply has to be
 * out of the door first, or the CLI dies with an empty stdout.
 */
interface Answer {
  result: unknown;
  after?: () => void;
}

type Handler = (args: Record<string, unknown>, caller: ControlRequest["caller"]) => Promise<Answer> | Answer;

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
 * The port the control server will listen on: derived from userData, the same on every platform
 * — so a dev checkout and the installed app, or two Windows accounts, each land on a port of
 * their own rather than the first one's. Bound and released again here, rather than trusted
 * outright, because Windows carves pieces out of the dynamic range for Hyper-V/WSL/Docker's own
 * NAT (`netsh int ipv4 show excludedportrange`) — a bind into one of those fails with `EACCES`,
 * not `EADDRINUSE`, and the exclusion is static enough that probing now and reusing the same
 * port at the real bind (see startControlServer) is reliable. Probed rather than left to the OS
 * to assign, because the port has to be in every terminal's environment (setControlEnv) before
 * the server actually starts (see main.ts's startControl, gated on the workspace opening).
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
      // The store keeps any string (see settings.ts); what it would silently fall back from is
      // refused here, where the caller can be told.
      if (theme !== SYSTEM_THEME_ID && !THEMES.some((candidate) => candidate.id === theme)) {
        throw new ControlError("bad_args", `unknown theme: ${theme} (see list-themes)`);
      }
      settings.save({ ...settings.get(), theme });
      // Never applied to the running window — xterm, shiki, monaco and the window chrome bake
      // the theme in at construction (see createWindow). The flag is for the agent to relay,
      // not to act on: restart-app is the user's call.
      return { result: { saved: true, restartRequired: true } };
    },

    "settings-set-prompt": (args) => {
      const id = text(args, "id", "prompt id");
      if (!PROMPT_IDS.some((candidate) => candidate === id)) {
        throw new ControlError("bad_args", `unknown prompt: ${id} (one of ${PROMPT_IDS.join(", ")})`);
      }
      // No text is the reset, same as the dialog's button: the store keeps "" for tet's own
      // (see settings.ts), and ipc.ts reads it at the moment of asking, so nothing to restart.
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
      const commands = (await deps.readCommands(found.path)) ?? [];
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
    }
  };
}

function reject(code: ControlErrorCode, message: string): ControlResponse {
  return { ok: false, error: { code, message } };
}

/** How long a connection may sit without a full request line — a tet-ctl writes it at once. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The local server an agent's `tet-ctl` talks to — a TCP socket on 127.0.0.1, one request per
 * connection (see src/shared/control.ts). Every request carries the token main.ts made for this
 * run; anything else is answered `unauthorized` and dropped, so a process that is not inside one
 * of tet's own terminals has nothing to say here.
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
      const answer = await handler(request.args ?? {}, request.caller ?? {});
      return { response: { ok: true, result: answer.result }, after: answer.after };
    } catch (error) {
      if (error instanceof ControlError) {
        return { response: reject(error.code, error.message) };
      }
      return { response: reject("internal", error instanceof Error ? error.message : String(error)) };
    }
  };

  // Every open connection, so `close` can end them: `net.Server.close` waits for each one, and
  // a client that connected and never sent its line would otherwise hold the quit open.
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    let answered = false;
    socket.on("data", (chunk: string) => {
      if (answered) {
        return;
      }
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      answered = true;
      // The verb itself takes as long as it takes (`projects-add` clones).
      socket.setTimeout(0);
      let request: ControlRequest;
      try {
        request = JSON.parse(buffer.slice(0, newline)) as ControlRequest;
      } catch {
        socket.end(JSON.stringify(reject("bad_args", "not a JSON request")) + "\n");
        return;
      }
      void handle(request).then(({ response, after }) => {
        if (after) {
          // Only once the CLI has the answer: `close` is the socket fully gone, not merely
          // our half of it written.
          socket.once("close", after);
        }
        socket.end(JSON.stringify(response) + "\n");
      });
    });
    socket.on("error", () => undefined);
  });

  // A TCP port, unlike a unix socket file, leaves nothing behind for a killed run to hand over:
  // the OS reclaims it the moment the process is gone, so EADDRINUSE here only ever means
  // another tet is genuinely listening on it — the single-instance lock makes that one about to
  // quit anyway (see main.ts). Nothing to recover, so bind once and let that error surface.
  await bind(server, port);

  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) {
          socket.destroy();
        }
      })
  };
}

function bind(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
