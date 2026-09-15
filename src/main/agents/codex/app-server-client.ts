import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { resolveCommand } from "../../terminals/pty";

/**
 * `codex app-server` speaks JSONL JSON-RPC 2.0 (without `jsonrpc`) over stdio. tet starts one per
 * request and tears it down: the shared `$CODEX_HOME` SQLite state does not tolerate concurrent
 * cold starts (measured: parallel starts against a fresh `CODEX_HOME` failed). The startup cost is
 * fine for rare renames and deletes.
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
 * Starts an app-server, runs `initialize`, sends one request and returns its result; rejects on a
 * JSON-RPC error, spawn failure or timeout. Always kills the process.
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
    /** Request id -> method, telling the initialize reply from the request's. */
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
    // A server that died early fails the write asynchronously; unhandled, that stream error
    // raises Electron's modal crash dialog.
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
        return; // A server notification.
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
 * `home`: the sandbox's mounted directory holding its rollouts and name index, used as `CODEX_HOME`.
 * Measured: a foreign CODEX_HOME needs no sign-in or config for `initialize` and `thread/*`, but
 * must exist, or it exits 1.
 */
export async function renameThread(executable: string, cwd: string, threadId: string, name: string, home?: string): Promise<void> {
  await callAppServer(executable, cwd, { method: "thread/name/set", params: { threadId, name } }, home);
}

/**
 * A thread without a rollout is already deleted and resolves (SessionProvider.remove). Measured
 * (codex-cli 0.154.0): an unknown id answers `-32600 no rollout found for thread id <id>`; matched
 * on the message, since -32600 is the generic "invalid request".
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
