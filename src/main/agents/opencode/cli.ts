import { spawn } from "node:child_process";
import { execInSandbox } from "../../sbx";
import { resolveCommand } from "../../terminals/pty";

/**
 * Runs `opencode <args>` to completion where the session lives: here, or in the named sandbox.
 * Each run boots opencode (~1.5 s measured, writing to the database), so only for one-offs —
 * delete, export, the background question's cleanup — never from a tab's output or a timer.
 * Resolves with stdout on exit 0, rejects with stderr otherwise.
 */
export function runOpencode(executable: string, cwd: string, sandbox: string | null | undefined, args: string[]): Promise<string> {
  if (sandbox) {
    return execInSandbox(sandbox, cwd, ["opencode", ...args]);
  }
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(executable, args);
    const child = spawn(resolved.command, resolved.args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`opencode ${args[0]} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`));
      }
    });
  });
}
