import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { killProcessTree, resolveCommand } from "../../terminals/pty";

/**
 * `codex app-server` speaks JSONL JSON-RPC 2.0 (without `jsonrpc`) over stdio. tet starts one per
 * request and tears it down, never a persistent one: the shared `$CODEX_HOME` SQLite state has a
 * write-lock race between instances and does not tolerate concurrent cold starts. The startup cost
 * is fine for rare renames; a delete is `codex delete` (sessions.ts).
 */
const REQUEST_TIMEOUT_MS = 15_000;

interface RpcRequest {
  method: string;
  params?: unknown;
}

/** One call at a time, across every project — two at once hit the cold-start race above. */
let queue: Promise<unknown> = Promise.resolve();

function callAppServer(executable: string, cwd: string, request: RpcRequest): Promise<unknown> {
  const call = queue.then(() => callAppServerNow(executable, cwd, request));
  queue = call.catch(() => undefined);
  return call;
}

/**
 * Starts an app-server, runs `initialize`, sends one request and returns its result; rejects on a
 * JSON-RPC error, spawn failure or timeout. Always kills the process.
 */
async function callAppServerNow(executable: string, cwd: string, request: RpcRequest): Promise<unknown> {
  const resolved = resolveCommand(executable, ["app-server", "--stdio"]);
  const child = spawn(resolved.command, resolved.args, {
    cwd,
    windowsHide: true,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"]
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
      killProcessTree(child);
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

export async function renameThread(executable: string, cwd: string, threadId: string, name: string): Promise<void> {
  await callAppServer(executable, cwd, { method: "thread/name/set", params: { threadId, name } });
}
