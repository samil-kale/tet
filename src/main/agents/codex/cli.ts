import { spawn } from "node:child_process";
import { killProcessTree, resolveCommand } from "../../terminals/pty";

/** As generous as the app-server call for the same one-offs (app-server-client.ts). */
const RUN_TIMEOUT_MS = 15_000;

/**
 * Runs `codex <args>` to completion on the host, for one-offs only. Resolves on exit 0, rejects
 * with stderr otherwise, or on the timeout. Unlike the app-server, parallel runs are fine
 * (measured, 0.156.1: six `codex delete` at once, against an existing and a fresh `CODEX_HOME`).
 */
export function runCodex(executable: string, cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(executable, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments
    });
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
      finish(() => reject(new Error(`codex ${args[0]} timed out after ${RUN_TIMEOUT_MS}ms`)));
    }, RUN_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`codex ${args[0]} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`));
        }
      });
    });
  });
}
