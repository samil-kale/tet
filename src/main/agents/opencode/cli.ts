import { spawn } from "node:child_process";
import { execInSandbox } from "../../sbx";
import { killProcessTree, resolveCommand } from "../../terminals/pty";

/**
 * How long a host run may take: ten times its measured boot, as generous as Codex's app-server
 * call for the same one-offs (app-server-client.ts), so a hung opencode fails a delete instead of
 * holding it forever.
 */
const RUN_TIMEOUT_MS = 15_000;

/**
 * Runs `opencode <args>` to completion where the session lives: here, or in the named sandbox.
 * Each run boots opencode (~1.5 s measured, writing to the database), so only for one-offs —
 * delete, export, the background question's cleanup — never from a tab's output or a timer.
 * Resolves with stdout on exit 0, rejects with stderr otherwise, or on the timeout.
 */
export function runOpencode(executable: string, cwd: string, sandbox: string | null | undefined, args: string[]): Promise<string> {
  if (sandbox) {
    return execInSandbox(sandbox, cwd, ["opencode", ...args]);
  }
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
    // Not `spawn`'s `timeout`: on win32 it kills only the cmd.exe in front of an npm shim (ask.ts).
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(() => reject(new Error(`opencode ${args[0]} timed out after ${RUN_TIMEOUT_MS}ms`)));
    }, RUN_TIMEOUT_MS);
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
          reject(new Error(`opencode ${args[0]} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`));
        }
      });
    });
  });
}
