import { execFile, spawn } from "node:child_process";
import { killProcessTree, resolveCommand } from "../terminals/pty";

const MAX_BUFFER = 64 * 1024 * 1024;
/** How much of a failed agent's output goes into a notice. */
const MAX_ERROR = 600;
const ASK_TIMEOUT_MS = 5 * 60_000;

/**
 * Asks an agent one question without a terminal; returns its stdout. The question goes on stdin:
 * on win32 an npm CLI is a `.cmd` shim behind cmd.exe, which mangles a multiline argument.
 */
export function askAgent(root: string, executable: string, args: string[], question: string): Promise<string> {
  const resolved = resolveCommand(executable, args);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(
      resolved.command,
      resolved.args,
      {
        cwd: root,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const reply = stdout.trim();
        // A CLI can print a usable answer and still exit non-zero; reject only an empty failure.
        if (error && reply.length === 0) {
          const reason = timedOut ? "The agent did not answer in time" : stderr.trim() || error.message;
          reject(new Error(reason.slice(0, MAX_ERROR)));
          return;
        }
        resolve(reply);
      }
    );
    // Not execFile's `timeout`: on win32 it kills only the cmd.exe in front of an npm shim, whose
    // child keeps stdout open and the callback waiting.
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, ASK_TIMEOUT_MS);
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(question);
  });
}

/**
 * Runs `<name> <args>` to completion on the host, for an agent's one-offs (codex/cli.ts,
 * opencode/cli.ts). Resolves with stdout on exit 0, rejects with stderr otherwise, or on the
 * timeout.
 */
export function runAgent(name: string, executable: string, cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(executable, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Not `spawn`'s `timeout`, as for askAgent.
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(() => reject(new Error(`${name} ${args[0]} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${name} ${args[0]} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`));
        }
      });
    });
  });
}
