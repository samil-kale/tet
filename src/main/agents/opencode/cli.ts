import { spawn } from "node:child_process";
import { execInSandbox } from "../../sbx";
import { resolveCommand } from "../../terminals/pty";

/**
 * One `opencode <args>` run to completion, where the session lives: on this machine, or inside
 * the sbx sandbox named. Each run boots an opencode of its own (~1.5 s measured, writing to the
 * database while at it), so this is for the one-off actions — delete, export, the one-time
 * seeding — never for anything a tab's output or a timer triggers. Resolves with stdout on exit
 * code 0 and rejects otherwise, with what the process said.
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
