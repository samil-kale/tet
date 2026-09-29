import { isSimulatedMissing } from "../util/simulate";
import { runProcess } from "../util/process";

/** The last answer per executable — a program installed while tet runs is not on its PATH anyway. */
const installedChecks = new Map<string, Promise<boolean>>();

/**
 * How long a version check may take before the program counts as missing. This runs before the
 * workspace opens (requirements.ts), so a check that never ends holds the whole start: generous
 * enough for a cold cmd.exe shim behind an antivirus scan, short enough to be a wait and not a
 * hang. Whatever it kills is reported as not installed — the tab then offers Restart, where a
 * start that hangs forever offers nothing.
 */
const VERSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Always spawns (the requirements re-check needs that) and remembers the answer.
 *
 * stdin is closed (runProcess): with the default pipe it stays open, and a `--version` that reads
 * a line (an interactive shim, a login prompt, cmd.exe's "Terminate batch job (Y/N)?") waits for
 * input nobody sends. stdout and stderr are not opened (`ignoreOutput`) — nothing reads them.
 */
export function checkAgentInstalled(executable: string, versionArgs: string[], cwd: string): Promise<boolean> {
  // Missing for the whole app, not only the requirements dialog, so a simulation holds everywhere.
  const check = isSimulatedMissing(executable)
    ? Promise.resolve(false)
    : runProcess(executable, versionArgs, { cwd, timeoutMs: VERSION_CHECK_TIMEOUT_MS, ignoreOutput: true }).then(
        (result) => result.code === 0
      );
  installedChecks.set(checkKey(executable, versionArgs), check);
  return check;
}

function checkKey(executable: string, versionArgs: string[]): string {
  return `${executable}\0${versionArgs.join("\0")}`;
}

export function isAgentInstalled(executable: string, versionArgs: string[], cwd: string): Promise<boolean> {
  return installedChecks.get(checkKey(executable, versionArgs)) ?? checkAgentInstalled(executable, versionArgs, cwd);
}
