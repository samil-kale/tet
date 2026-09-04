import { execFile } from "node:child_process";
import { resolveCommand } from "../terminals/pty";

/** How much a background agent may write before node stops buffering it. */
const MAX_BUFFER = 64 * 1024 * 1024;
/** How much of a failed agent's output is useful in a notice. */
const MAX_ERROR = 600;
/** An agent that neither answers nor gives up is not going to. */
const ASK_TIMEOUT_MS = 5 * 60_000;

/**
 * Puts one question to an agent without opening a terminal and returns its stdout. The question
 * goes in on stdin: on win32 an npm-installed CLI is a `.cmd` shim behind cmd.exe, which does
 * not safely carry a multiline prompt as an argument.
 */
export function askAgent(root: string, executable: string, args: string[], question: string): Promise<string> {
  const { command, args: resolved } = resolveCommand(executable, args);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(
      command,
      resolved,
      { cwd: root, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const reply = stdout.trim();
        // Some CLIs have printed a usable answer before returning a non-zero exit code. The
        // caller knows what a usable answer looks like; only an empty failure is ours to reject.
        if (error && reply.length === 0) {
          const reason = timedOut ? "The agent did not answer in time" : stderr.trim() || error.message;
          reject(new Error(reason.slice(0, MAX_ERROR)));
          return;
        }
        resolve(reply);
      }
    );
    // Not execFile's own `timeout`: on win32 that only kills the cmd.exe in front of an npm
    // shim. Its child keeps stdout open, so the callback above would still wait indefinitely.
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid !== undefined) {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
      } else {
        child.kill();
      }
    }, ASK_TIMEOUT_MS);
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(question);
  });
}
