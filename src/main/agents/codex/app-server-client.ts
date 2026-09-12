import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { resolveCommand } from "../../terminals/pty";

/**
 * `codex app-server` is a JSON-RPC-over-stdio process (JSONL, JSON-RPC 2.0 without the `jsonrpc`
 * field). tet starts one, sends exactly one request and tears it down: the `$CODEX_HOME` SQLite
 * state every repository's Codex shares does not tolerate concurrent first-time startup
 * (measured: parallel cold starts against a fresh `CODEX_HOME` failed outright). Nearly all of
 * the round trip is that startup, affordable for the rare rename and delete this is for.
 */
const REQUEST_TIMEOUT_MS = 15_000;

interface RpcRequest {
  method: string;
  params?: unknown;
}

/** One call at a time, across every project — two at once hit the cold-start race above. */
let queue: Promise<unknown> = Promise.resolve();

function callAppServer(executable: string, cwd: string, request: RpcRequest, home?: string): Promise<unknown> {
  const call = queue.then(() => callAppServerNow(executable, cwd, request, home));
  queue = call.catch(() => undefined);
  return call;
}

/**
 * Starts one `codex app-server`, performs the `initialize` handshake, sends one further request
 * and returns its result — rejecting on a JSON-RPC error, spawn failure or timeout. The process
 * is always killed on the way out.
 */
async function callAppServerNow(executable: string, cwd: string, request: RpcRequest, home?: string): Promise<unknown> {
  const { command, args } = resolveCommand(executable, ["app-server", "--stdio"]);
  const child = spawn(command, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: home === undefined ? process.env : { ...process.env, CODEX_HOME: home }
  });

  return new Promise((resolve, reject) => {
    let nextId = 1;
    /** Request id -> method, to tell the initialize reply from the actual request's. */
    const pending = new Map<number, string>();
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`codex app-server timed out after ${REQUEST_TIMEOUT_MS}ms`)));
    }, REQUEST_TIMEOUT_MS);

    const send = (method: string, params?: unknown): number => {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      return id;
    };

    child.on("error", (error) => finish(() => reject(error)));
    // An app-server that died before reading its request fails the write asynchronously, and an
    // unhandled stream error takes the main process into Electron's modal crash dialog.
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (!settled) {
        finish(() => reject(new Error(`codex app-server exited (${code}): ${stderr.trim().slice(0, 500)}`)));
      }
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.id !== "number") {
        return; // A server-pushed notification, not a response to anything tet asked.
      }
      const method = pending.get(message.id);
      if (!method) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        finish(() => reject(new Error(String(message.error?.message ?? "codex app-server request failed"))));
        return;
      }
      if (method === "initialize") {
        pending.set(send(request.method, request.params), request.method);
      } else {
        finish(() => resolve(message.result));
      }
    });

    const initId = send("initialize", {
      clientInfo: { name: "tet", title: "tet", version: "0" }
    });
    pending.set(initId, "initialize");
  });
}

/**
 * `home` is what a sandboxed session needs: its rollouts and name index live in the directory tet
 * mounts into the sandbox, so the one-shot app-server is pointed at that as its `CODEX_HOME`.
 * Measured: a foreign CODEX_HOME needs no sign-in and no config of its own — `initialize` and a
 * `thread/*` request both answer — but the directory has to exist, or it exits 1.
 */
export async function renameThread(executable: string, cwd: string, threadId: string, name: string, home?: string): Promise<void> {
  await callAppServer(executable, cwd, { method: "thread/name/set", params: { threadId, name } }, home);
}

/**
 * A thread whose rollout is gone is already deleted — resolved, not rejected, per
 * SessionProvider.remove. Measured (codex-cli 0.154.0): `thread/delete` for an unknown id answers
 * `-32600 no rollout found for thread id <id>`. Matched on the message because -32600 is the
 * generic "invalid request"; should the wording change, the worst is today's behaviour back.
 */
export async function deleteThread(executable: string, cwd: string, threadId: string, home?: string): Promise<void> {
  try {
    await callAppServer(executable, cwd, { method: "thread/delete", params: { threadId } }, home);
  } catch (error) {
    if (!String(error).includes("no rollout found")) {
      throw error;
    }
  }
}
