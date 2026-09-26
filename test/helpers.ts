import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { safeStorage, utilityProcess } from "electron";
import { findControlPort } from "../src/main/control/control-server";
import { tabControlToken } from "../src/main/control/control-token";
import * as gitModule from "../src/main/git/git";
import type { GitRequest, GitResponse } from "../src/main/git/git-host";
import { CONTROL_ENV } from "../src/shared/control";
import type { GitLogin } from "../src/shared/types";

/**
 * Stands in for the OS's encryption (electron-stub.js's `safeStorage`): "sealed:" is the cipher,
 * and anything else was sealed under another keychain, which decrypting throws on as the real
 * thing does. `available` false is a machine with no keyring.
 */
export function fakeSafeStorage(available = true): void {
  Object.assign(safeStorage, {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString();
      if (!text.startsWith("sealed:")) {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      }
      return text.slice("sealed:".length);
    }
  });
}

/** Whether a process is still there. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The built CLI — the tests run what ships, not the source. */
export const CLI = path.join(__dirname, "..", "dist", "tet-ctl.js");

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout, when the CLI printed a result. */
  result: unknown;
}

/**
 * Runs the built CLI with the channel in its environment, as a tet terminal would. Async because
 * in control.test.ts the server runs on this event loop, which a `spawnSync` would block.
 */
export function tetCtl(args: string[], env: Record<string, string | undefined>, input = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    // Always closed: a hook reads its payload here, and would wait forever on an open stdin.
    child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (status) => {
      let result: unknown;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = undefined;
      }
      resolve({ status: status ?? -1, stdout, stderr, result });
    });
  });
}

/**
 * Polls until `check` holds, or fails with `what` after `ms`. A thunk `what` is evaluated at
 * failure time, so it can include state gathered while polling (e.g. stderr).
 */
export async function eventually(
  what: string | (() => string),
  check: () => boolean | Promise<boolean>,
  ms = 1000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, ms / 20)));
  }
  assert.ok(await check(), `${typeof what === "function" ? what() : what} — not within ${ms}ms`);
}

/**
 * The real app on a profile of its own (`--user-data-dir`) with a token handed in, driven through
 * tet-ctl alone (app.test.ts, agents.test.ts).
 */
export interface TestApp {
  /** The electron started here — not the instance a `restart-app` leaves. */
  child: ChildProcess;
  /** Everything that electron wrote to stderr so far. */
  stderr(): string;
  ctl(...args: string[]): Promise<Run>;
  /** The environment a tab of `projectId` is started with: its ids and the token made for them. */
  asTab(projectId: string, tabId: string): Record<string, string | undefined>;
  /** The tab's latest output, read as that tab: `tabs-output` answers only within its project. */
  output(projectId: string, tabId: string): Promise<string>;
  /** The pid of the instance answering right now, if any. */
  alive(): Promise<number | undefined>;
}

/** Starts tet and resolves once it answers; a start that never answers is killed before rejecting. */
export async function startApp(userData: string, token: string, startupMs: number): Promise<TestApp> {
  // Speaks for no tab: the run's token takes no caller ids, and a run from a TET tab inherits some.
  const env: Record<string, string | undefined> = {
    [CONTROL_ENV.port]: String(await findControlPort(userData)),
    [CONTROL_ENV.token]: token,
    [CONTROL_ENV.projectId]: undefined,
    [CONTROL_ENV.worktree]: undefined,
    [CONTROL_ENV.tabId]: undefined
  };
  const args = [path.join(__dirname, ".."), `--user-data-dir=${userData}`, "--allow-shell-only"];
  if (process.platform === "linux") {
    // ubuntu-latest ships chrome-sandbox without the setuid bit and AppArmor blocks the userns
    // fallback, so Electron aborts on launch. The installed `tet` passes it too (install.sh).
    args.push("--no-sandbox");
  }
  const electronPath: string = createRequire(__filename)("electron");
  // Not a Claude Code session's own variables, when the tests run inside one (an agent tab): an
  // interactive `claude` started with them answers but writes no transcript.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(key)));
  const child = spawn(electronPath, args, {
    env: { ...inherited, [CONTROL_ENV.token]: token, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const ctl = (...ctlArgs: string[]): Promise<Run> => tetCtl(ctlArgs, env);
  const asTab = (projectId: string, tabId: string): Record<string, string | undefined> => ({
    ...env,
    [CONTROL_ENV.token]: tabControlToken(token, { projectId }, tabId, false),
    [CONTROL_ENV.projectId]: projectId,
    [CONTROL_ENV.tabId]: tabId
  });
  const app: TestApp = {
    child,
    stderr: () => stderr,
    ctl,
    asTab,
    output: async (projectId, tabId) => {
      const read = await tetCtl(["tabs-output", tabId, "--kb", "64"], asTab(projectId, tabId));
      return (read.result as { output: string } | undefined)?.output ?? "";
    },
    alive: async () => {
      const run = await ctl("version");
      return run.status === 0 ? (run.result as { pid: number }).pid : undefined;
    }
  };
  try {
    await eventually(() => `tet answering on port ${env[CONTROL_ENV.port]}\n${stderr}`, async () => (await app.alive()) !== undefined, startupMs);
  } catch (error) {
    // Nothing left holding the profile directory.
    if (child.pid !== undefined) {
      killApp(child.pid);
    }
    throw error;
  }
  return app;
}

/** Ends the app; on win32 always by force, as the signal is not a thing there. */
export function killApp(target: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  if (process.platform === "win32") {
    // The whole tree: a shell tab is a process of its own under the app.
    spawnSync("taskkill", ["/pid", String(target), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(target, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * git without the machine's config: a signing key or a hook there would turn a commit into a
 * question. `name` gives each file an empty global config of its own.
 */
export function isolateGitConfig(name: string): void {
  const identity = {
    GIT_AUTHOR_NAME: "tet test",
    GIT_AUTHOR_EMAIL: "test@tet.invalid",
    GIT_COMMITTER_NAME: "tet test",
    GIT_COMMITTER_EMAIL: "test@tet.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), name)
  };
  Object.assign(process.env, identity);
  fs.writeFileSync(identity.GIT_CONFIG_GLOBAL, "");
}

/** Runs git in `cwd`, failing the test on a non-zero exit; answers stdout, trimmed. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository on main with one commit of a.txt, in a temporary folder named after `prefix`. */
export function initRepository(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, "init", "-q", "--initial-branch=main");
  fs.writeFileSync(path.join(dir, "a.txt"), "committed\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** A bare repository on main, for a test that needs something to push to. */
export function initBare(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, "init", "-q", "--bare", "--initial-branch=main");
  return dir;
}

/** A bare repository served over http by `git http-backend`, behind a basic-auth login that can be
 *  changed while it runs (a revoked token). */
export interface HttpRemote {
  url: string;
  login: GitLogin;
  close: () => void;
}

export async function serveOverHttp(bare: string, login: GitLogin): Promise<HttpRemote> {
  const remote = { login: { ...login } };
  const server = http.createServer((request, response) => {
    const expected = `Basic ${Buffer.from(`${remote.login.username}:${remote.login.password}`).toString("base64")}`;
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="tet"' });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    // CGI: the request in the environment and on stdin, the response headers and body on stdout.
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: path.dirname(bare),
        GIT_HTTP_EXPORT_ALL: "1",
        // A user makes receive-pack (push) available.
        REMOTE_USER: remote.login.username,
        REQUEST_METHOD: request.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        ...(request.headers["content-length"] ? { CONTENT_LENGTH: request.headers["content-length"] } : {}),
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: String(request.headers["git-protocol"] ?? "")
      }
    });
    request.pipe(backend.stdin);
    const chunks: Buffer[] = [];
    backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    backend.on("close", () => {
      const output = Buffer.concat(chunks);
      const crlf = output.indexOf("\r\n\r\n");
      const end = crlf !== -1 ? crlf : output.indexOf("\n\n");
      const gap = crlf !== -1 ? 4 : 2;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of output.subarray(0, end).toString().split(/\r?\n/)) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") {
          status = parseInt(value, 10);
        } else if (name) {
          headers[name] = value;
        }
      }
      response.writeHead(status, headers);
      response.end(output.subarray(end + gap));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/${path.basename(bare)}`,
    login: remote.login,
    close: () => server.close()
  };
}

/** The electron stub's `utilityProcess` running git.ts in this process, as git-host.ts would. */
export function forkGitInProcess(): void {
  const api = gitModule as unknown as Record<string, (...args: unknown[]) => unknown>;
  Object.assign(utilityProcess, {
    fork: () => {
      let listener: (message: GitResponse) => void = () => undefined;
      return {
        on: (event: string, handler: (message: GitResponse) => void) => {
          if (event === "message") {
            listener = handler;
          }
        },
        postMessage: ({ id, method, args }: GitRequest) => {
          void (async () => {
            try {
              listener({ id, value: await api[method](...args) });
            } catch (error) {
              listener({ id, error: error instanceof Error ? error.message : String(error) });
            }
          })();
        },
        kill: () => undefined
      };
    }
  });
}
