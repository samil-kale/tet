import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree, resolveCommand } from "./terminals/pty";

export interface RunProcessOptions {
  cwd?: string;
  /** Written to stdin, then closed. Without it stdin is closed from the start, so a command waiting
   *  on it fails rather than waits for input nobody sends. */
  stdin?: string;
  /** Past this the process is killed with its children and the run answers at once, `timedOut`. */
  timeoutMs?: number;
  /** Every stdout and stderr chunk as it arrives, in arrival order. */
  onData?: (chunk: string) => void;
  /** Handed the process once started, e.g. to kill it on a Cancel. */
  onSpawn?: (child: ChildProcess) => void;
  /** Neither pipe is opened: nothing is read, so a grandchild inheriting them cannot hold the run
   *  open, and an unread pipe cannot fill and block the program. */
  ignoreOutput?: boolean;
}

export interface ProcessResult {
  /** The exit code; null when the process could not start, died of a signal or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why the process could not be started. */
  error?: Error;
}

/**
 * Runs a command to completion through `resolveCommand`, without a shell, and never rejects. It
 * answers on `close`, once every pipe is drained, so no output is cut off. The timeout does not wait
 * for that: a child the program started can hold the pipes open past its end. Killed with its
 * children, as on win32 `kill()` would end only the cmd.exe in front of a shim (killProcessTree).
 */
export function runProcess(executable: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const resolved = resolveCommand(executable, args);
    const output = options.ignoreOutput ? "ignore" : "pipe";
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", output, output]
    });
    options.onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    // Decoded per stream, so a character split across two chunks stays whole.
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      options.onData?.(chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      options.onData?.(chunk);
    });
    let settled = false;
    const finish = (result: Omit<ProcessResult, "stdout" | "stderr">): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, stdout, stderr });
      }
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killProcessTree(child);
            finish({ code: null, timedOut: true });
          }, options.timeoutMs);
    child.on("error", (error) => finish({ code: null, timedOut: false, error }));
    child.on("close", (code) => finish({ code, timedOut: false }));
    if (options.stdin !== undefined) {
      // A command gone before reading it fails the write (EPIPE); unhandled, that stream error
      // raises Electron's modal crash dialog. The exit reports the failure.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin);
    }
  });
}
