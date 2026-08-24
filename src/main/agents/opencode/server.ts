import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { countActivity } from "../../event-loop-monitor";
import { resolveCommand } from "../../terminals/pty";
import type { AgentPaths, SpawnPreparation } from "../agent";
import { installContextPlugin } from "./context-plugin";
import {
  createOpencodeNotifier,
  SESSION_BUSY_STATUS,
  SESSION_FINISHED_EVENT,
  SESSION_STATUS_EVENT,
  SESSION_WAITING_EVENTS
} from "./notify";
import { basicAuth, forgetServer, killServerTree, rememberServer, serversReclaimed } from "./server-registry";
import { installTuiConfig } from "./tui-config";

const SERVER_START_TIMEOUT_MS = 15_000;
const EVENT_RETRY_MS = 2000;

/**
 * opencode is a client/server program: `opencode serve` is the instance that owns the
 * SQLite database, and the TUI is one of its clients (`opencode attach <url>`). TET
 * runs that server itself and points everything at it — the session listing, renames, the
 * event stream, and the terminal's own TUI.
 *
 * Talking to opencode any other way means a second, unrelated instance sharing only the
 * database file. Measured: every `session list` boots one (~1.2s, versus ~12ms over HTTP), a
 * read writes to the database, and events never cross the process boundary — a change made in
 * the terminal's TUI stays invisible to us.
 */
/**
 * One event off the server's stream, reduced to what anything here acts on. `sessionId` is
 * absent for the events that are about the server rather than about one session.
 */
export interface OpencodeEvent {
  type: string;
  sessionId?: string;
  /**
   * What `session.status` says the session is doing, e.g. "busy". opencode models it as a
   * tagged union, so the tag is the whole of what is read here — its other branches carry a
   * provider, a title and a link that nothing in tet acts on.
   */
  status?: string;
}

export class OpencodeServer {
  private eventsAborted: AbortController | undefined;
  private readonly subscribers = new Set<(event: OpencodeEvent) => void>();
  private readonly child: ChildProcess;
  readonly url: string;
  readonly password: string;
  private readonly authorization: string;

  private constructor(child: ChildProcess, url: string, password: string) {
    this.child = child;
    this.url = url;
    this.password = password;
    this.authorization = basicAuth(password);
  }

  /**
   * One server comes up at a time, however many projects ask at once. Every `opencode serve` on
   * this machine opens the same SQLite database, and four of them booting inside the same 40ms
   * is what the loser reports as "database is locked" before it exits with code 1 — observed
   * with four repositories restored at startup. Waiting for the one before to report its url is
   * enough: by then it is past the setup that holds the write lock.
   */
  private static queue: Promise<unknown> = Promise.resolve();

  static start(executable: string, cwd: string, env?: Record<string, string>): Promise<OpencodeServer> {
    const started = OpencodeServer.queue.then(() => OpencodeServer.boot(executable, cwd, env));
    // What the next caller waits on must carry neither this one's rejection nor its server.
    OpencodeServer.queue = started.then(
      () => undefined,
      () => undefined
    );
    return started;
  }

  private static async boot(executable: string, cwd: string, env?: Record<string, string>): Promise<OpencodeServer> {
    // A server a previous run left running holds that same database, so nothing starts until
    // those are gone either — see server-registry.ts.
    await serversReclaimed();
    // Without a password opencode serves every local process unauthenticated — it says so
    // on startup. The secret is generated per server and never leaves this process and the
    // ones we hand it to, so the port is only useful to us.
    const password = crypto.randomBytes(24).toString("base64url");
    const { command, args } = resolveCommand(executable, ["serve", "--port", "0", "--hostname", "127.0.0.1"]);
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // A process group of its own, so killServerTree can take the launcher and the binary it
      // starts down together — the POSIX half of what taskkill /t does on win32.
      detached: process.platform !== "win32",
      // Same precedence as spawnAgentProcess: what the caller passes are defaults a
      // variable the user already has set still wins over — we must not silently replace
      // their own OPENCODE_CONFIG_DIR. The password is ours alone and does win.
      env: { ...env, ...process.env, OPENCODE_SERVER_PASSWORD: password }
    });
    try {
      const url = await waitForServerUrl(child);
      if (child.pid !== undefined) {
        rememberServer({ pid: child.pid, url, password, cwd });
      }
      return new OpencodeServer(child, url, password);
    } catch (error) {
      killTree(child);
      throw error;
    }
  }

  get running(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  /**
   * Every endpoint we use is scoped by `directory`, so it's added here rather than at each
   * call site, behind whatever query a path already carries.
   */
  async request(path: string, cwd: string, init?: RequestInit): Promise<Response> {
    const url = `${this.url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(cwd)}`;
    const response = await fetch(url, {
      ...init,
      headers: { ...init?.headers, Authorization: this.authorization }
    });
    if (!response.ok) {
      throw new Error(`opencode ${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  /**
   * Reports each event until dispose(), reconnecting if the stream drops. One stream serves
   * every subscriber: opencode delivers the same events to each connection, so a second would
   * only cost another server-side subscriber for the same payload.
   */
  subscribe(cwd: string, onEvent: (event: OpencodeEvent) => void): () => void {
    this.subscribers.add(onEvent);
    if (!this.eventsAborted) {
      this.eventsAborted = new AbortController();
      void this.streamEvents(cwd, this.eventsAborted);
    }
    return () => this.subscribers.delete(onEvent);
  }

  private async streamEvents(cwd: string, controller: AbortController): Promise<void> {
    while (!controller.signal.aborted && this.running) {
      try {
        const response = await this.request("/event", cwd, { signal: controller.signal });
        const reader = response.body?.getReader();
        if (!reader) {
          return;
        }
        const decoder = new TextDecoder();
        let buffer = "";
        // Where the last search for a frame boundary stopped: a large event arriving over many
        // reads would otherwise be rescanned from its start on every one of them.
        let searchFrom = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          // Server-sent events are separated by a blank line; only the "data:" line of
          // each carries the payload.
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n", searchFrom)) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            searchFrom = 0;
            countActivity("sse");
            const data = frame.split("\n").find((line) => line.startsWith("data: "));
            const event = data === undefined ? undefined : parseEvent(data.slice("data: ".length));
            if (event !== undefined) {
              for (const subscriber of this.subscribers) {
                subscriber(event);
              }
            }
          }
          // One back, in case the buffer ends in the first "\n" of a boundary.
          searchFrom = Math.max(0, buffer.length - 1);
        }
      } catch {
        // Stream dropped (server restart, transient error) — retried below. An abort
        // leaves the loop through its own condition instead.
      }
      if (controller.signal.aborted) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, EVENT_RETRY_MS));
    }
  }

  dispose(): void {
    this.eventsAborted?.abort();
    killTree(this.child);
  }
}

interface ServerEntry {
  executable: string;
  /** Started with an environment of its own — the context plugin's — rather than bare. */
  configured: boolean;
  server: Promise<OpencodeServer>;
}

/** One server per repository — tet can have several projects open at once. */
const servers = new Map<string, ServerEntry>();

/** A start that never succeeded has nothing to dispose, hence the swallowed rejection. */
function disposeQuietly(entry: ServerEntry | undefined): void {
  entry?.server.then((server) => server.dispose()).catch(() => undefined);
}

export async function ensureServer(
  executable: string,
  cwd: string,
  env?: Record<string, string>
): Promise<OpencodeServer> {
  const existing = servers.get(cwd);
  // A server started bare (a listing with no tab behind it) does not serve a caller bringing
  // the plugin's environment: the plugin loads at startup, so that one is replaced.
  if (existing?.executable === executable && (!env || existing.configured)) {
    try {
      const server = await existing.server;
      if (server.running) {
        return server;
      }
    } catch {
      // Previous start failed — fall through and try again below.
    }
  }
  disposeQuietly(existing);
  const started = OpencodeServer.start(executable, cwd, env);
  servers.set(cwd, { executable, configured: env !== undefined, server: started });
  return started;
}

/**
 * Ends a server that was started for one job and belongs to no preparation — provided it is
 * still the one this repository runs on, and not a replacement a spawn has since put there.
 */
export async function stopServer(cwd: string, server: OpencodeServer): Promise<void> {
  const entry = servers.get(cwd);
  if (entry && (await entry.server.catch(() => undefined)) === server) {
    servers.delete(cwd);
    server.dispose();
  }
}

/**
 * The server this repository is already running on, if any — never starts one. For callers only
 * along for the ride (a url lookup triggered by a hover), where starting a second instance
 * would be the very thing this module exists to avoid.
 */
export async function runningServer(executable: string, cwd: string): Promise<OpencodeServer | undefined> {
  const existing = servers.get(cwd);
  if (existing?.executable !== executable) {
    return undefined;
  }
  try {
    const server = await existing.server;
    return server.running ? server : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Brings the server up before any terminal is spawned and hands the TUI the arguments to attach
 * to it, so the terminal's session and everything else tet does run in one instance.
 */
export async function prepareOpencodeSpawn(
  executable: string,
  cwd: string,
  paths: AgentPaths
): Promise<SpawnPreparation> {
  // On the server, not on the terminal: under `attach` the TUI is only a client, and the
  // server is what composes messages and therefore what loads the plugin.
  const server = await ensureServer(executable, cwd, installContextPlugin(paths.storageRoot, cwd, paths.contextFile));
  // Subscribing here rather than in the notifier keeps the stream's lifetime tied to the
  // server's: it is torn down in the same dispose that stops the server.
  const notify = createOpencodeNotifier(paths.agentDir, cwd, "OpenCode", paths.notifications);
  const unsubscribe = server.subscribe(cwd, (event) => {
    notify(event.type);
    // Both ends of a turn, and one of them is the very event the "Finished" toast is built on.
    // Unlike Claude Code, opencode says all of this itself over a stream tet already holds
    // — nothing is read off the TUI, and nothing crosses a process boundary through a file.
    if (!event.sessionId) {
      return;
    }
    if (event.type === SESSION_FINISHED_EVENT) {
      paths.onSessionFinished(event.sessionId);
    } else if (event.type === SESSION_STATUS_EVENT && event.status === SESSION_BUSY_STATUS) {
      paths.onSessionBusy(event.sessionId);
    } else if ((SESSION_WAITING_EVENTS as readonly string[]).includes(event.type)) {
      // Not an end of the turn — the session is still busy and stays that way until it idles.
      paths.onSessionWaiting(event.sessionId);
    }
  });
  return {
    args: ["attach", server.url, "--dir", cwd],
    // A whole process per repository, started for the session listing alone — not worth
    // keeping up for a project whose opencode is never used.
    releaseWhenIdle: true,
    // attach reads the password from the environment; passing it as --password would put
    // the secret in the process command line, where any local process can read it. The tui
    // config is on the terminal for the other reason the plugin is on the server: the TUI is
    // the half that draws — and only when the Appearance tab says the agents draw in tet's
    // theme; otherwise opencode paints its own, full background and all.
    env: {
      OPENCODE_SERVER_PASSWORD: server.password,
      ...(paths.themeAgents ? installTuiConfig(paths.storageRoot) : {})
    },
    dispose: () => {
      unsubscribe();
      const previous = servers.get(cwd);
      servers.delete(cwd);
      disposeQuietly(previous);
    }
  };
}

/**
 * The types anything here listens for: `session.*` (both ends of a turn, the listing's watch,
 * `session.error`'s toast) and the two questions.
 */
const CONSUMED_EVENT_TYPE = new RegExp(
  `"type"\\s*:\\s*"(?:session\\.|${SESSION_WAITING_EVENTS.map((type) => type.replace(".", "\\.")).join("|")})`
);

/**
 * An event carries what it is about under `properties`, in opencode's own spelling
 * (`sessionID`). Read defensively like every field that crosses from another program: one
 * without it is still an event, just not about a session.
 */
function parseEvent(payload: string): OpencodeEvent | undefined {
  // Only a few event types are ever acted on (see the subscribers), and the rest — every
  // `message.part.updated` of a streaming answer, carrying the answer's text — is the bulk of
  // the stream. A payload that names none of them nowhere is not parsed at all: JSON.parse of
  // every frame was main-process CPU spent while the ptys wait. Tolerant of whitespace around
  // the colon; a nested match only costs the parse it would have had anyway.
  if (!CONSUMED_EVENT_TYPE.test(payload)) {
    return undefined;
  }
  try {
    const event = JSON.parse(payload) as {
      type?: unknown;
      properties?: { sessionID?: unknown; status?: { type?: unknown } };
    };
    if (typeof event.type !== "string") {
      return undefined;
    }
    const sessionId = event.properties?.sessionID;
    const status = event.properties?.status?.type;
    return {
      type: event.type,
      sessionId: typeof sessionId === "string" ? sessionId : undefined,
      status: typeof status === "string" ? status : undefined
    };
  } catch {
    return undefined;
  }
}

/** The tail of what the server said, for a failure that otherwise names no cause at all. */
function said(output: string): string {
  const text = output.trim().split("\n").slice(-3).join(" / ").slice(0, 300);
  return text ? ` — it said: ${text}` : " and said nothing";
}

/**
 * Resolves once `opencode serve` reports the URL it's listening on. **Both** streams are read:
 * the url only ever comes on stdout, but a server that dies instead says why on stderr, and
 * without that the failure reaches the user as "it did not start" and nothing else.
 */
function waitForServerUrl(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`opencode serve timed out waiting for its listening URL${said(buffer)}`));
    }, SERVER_START_TIMEOUT_MS);
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const match = /listening on (http:\/\/\S+)/.exec(buffer);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const how = code === null ? `on ${signal}` : `with code ${code}`;
      reject(new Error(`opencode serve exited ${how} before reporting a listening URL${said(buffer)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.stdout?.off("data", onData);
      server.stderr?.off("data", onData);
      server.off("error", onError);
      server.off("exit", onExit);
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    server.on("error", onError);
    server.on("exit", onExit);
  });
}

/**
 * Takes the server down and strikes it off the registry in one place, so a server this run
 * disposed of is not one the next run goes looking for. A child without a pid never started,
 * and there is nothing to take down.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  forgetServer(child.pid);
  void killServerTree(child.pid);
}
