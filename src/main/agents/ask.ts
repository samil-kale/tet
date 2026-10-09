import { runProcess, type RunProcessOptions } from "../util/process";

/** How much of a failed agent's output goes into a notice. */
const MAX_ERROR = 600;
const ASK_TIMEOUT_MS = 5 * 60_000;

/**
 * Asks an agent one question without a terminal; returns its stdout. The question goes on stdin:
 * on win32 an npm CLI is a `.cmd` shim behind cmd.exe, which mangles a multiline argument.
 * `onSpawn`: handed the process, for a Cancel to kill it.
 */
export async function askAgent(
  root: string,
  executable: string,
  args: string[],
  question: string,
  onSpawn?: RunProcessOptions["onSpawn"],
): Promise<string> {
  const result = await runProcess(executable, args, { cwd: root, stdin: question, timeoutMs: ASK_TIMEOUT_MS, onSpawn });
  const reply = result.stdout.trim();
  // The exit code, not the text: a CLI refusing (a usage limit) or cut off says so on stdout too,
  // and that is no answer.
  if (result.code !== 0) {
    const reason = result.timedOut
      ? "The agent did not answer in time"
      : result.stderr.trim() || reply || (result.error?.message ?? `${executable} exited with code ${result.code}`);
    throw new Error(reason.slice(0, MAX_ERROR));
  }
  return reply;
}

/**
 * Runs `<name> <args>` to completion on the host, for an agent's one-offs (`codex delete`,
 * `pi --list-models`). Resolves with stdout on exit 0, rejects with stderr otherwise, or on the
 * timeout.
 */
export async function runAgent(name: string, executable: string, cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await runProcess(executable, args, { cwd, timeoutMs });
  if (result.error) {
    throw result.error;
  }
  if (result.timedOut) {
    throw new Error(`${name} ${args[0]} timed out after ${timeoutMs}ms`);
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`${name} ${args[0]} exited with code ${result.code}${stderr ? `: ${stderr.slice(-300)}` : ""}`);
  }
  return result.stdout;
}
