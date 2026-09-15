import { execFile } from "node:child_process";
import { resolveCommand } from "../terminals/pty";

const MAX_BUFFER = 64 * 1024 * 1024;
/** How much of a failed agent's output goes into a notice. */
const MAX_ERROR = 600;
const ASK_TIMEOUT_MS = 5 * 60_000;

/**
 * Asks an agent one question without a terminal; returns its stdout. The question goes on stdin:
 * on win32 an npm CLI is a `.cmd` shim behind cmd.exe, which mangles a multiline argument.
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
