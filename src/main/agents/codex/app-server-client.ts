import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { resolveCommand } from "../../terminals/pty";

/**
 * `codex app-server` is a JSON-RPC-over-stdio process (JSONL, JSON-RPC 2.0 without the
 * `jsonrpc` field), not a persistently running server — tet starts one, sends exactly one
 * request, and tears it down. Timed against a real install: ~300-500 ms end to end, almost all
 * of it the process's own startup (config/discovery), the request itself answering in single-
 * digit milliseconds — acceptable for the rare, user-triggered actions this is for (rename,
 * delete). Stays one-shot rather than a server tet keeps running: the same `$CODEX_HOME` SQLite state
 * every repository's Codex shares does not tolerate concurrent first-time startup (measured: 2
 * of 6 parallel cold starts against a fresh `CODEX_HOME` failed outright).
 */
const REQUEST_TIMEOUT_MS = 15_000;

interface RpcRequest {
  method: string;
  params?: unknown;
}

/**
 * One call at a time, across every project: two tabs closed within a second (or a rename and
 * a close) would otherwise start two of these against the same state database — the very
 * cold-start race described above.
 */
let queue: Promise<unknown> = Promise.resolve();

function callAppServer(executable: string, cwd: string, request: RpcRequest): Promise<unknown> {
  const call = queue.then(() => callAppServerNow(executable, cwd, request));
  queue = call.catch(() => undefined);
  return call;
}

/**
 * Starts one `codex app-server` process, performs the `initialize` handshake, sends one further
 * request, and returns its result — rejecting on a JSON-RPC error, a spawn failure, or timeout.
 * The process is always killed on the way out, success or failure alike.
 */
async function callAppServerNow(executable: string, cwd: string, request: RpcRequest): Promise<unknown> {
  const { command, args } = resolveCommand(executable, ["app-server", "--stdio"]);
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

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

export async function renameThread(executable: string, cwd: string, threadId: string, name: string): Promise<void> {
  await callAppServer(executable, cwd, { method: "thread/name/set", params: { threadId, name } });
}

export async function deleteThread(executable: string, cwd: string, threadId: string): Promise<void> {
  await callAppServer(executable, cwd, { method: "thread/delete", params: { threadId } });
}
