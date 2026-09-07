import * as os from "node:os";
import { AGENTS } from "./agents";
import type { AgentDefinition } from "./agents/agent";
import type { Requirement, Requirements } from "../shared/types";
import { git } from "./git/git-client";
import { checkAgentInstalled } from "./terminals/terminal-session";

/** An agent that has to be installed; the shell has no `versionArgs` and is always there. */
type InstallableAgent = AgentDefinition & { versionArgs: string[] };

const GIT: Omit<Requirement, "installed"> = {
  name: "Git",
  command: "git",
  url: "https://git-scm.com/downloads"
};

/**
 * The commands `--simulate` names, reported missing however installed they are — otherwise the
 * dialog is unreachable on a machine that has everything: `npm start -- --simulate=git,claude`,
 * where npm's own `--` hands the flag past the script to electron.
 */
const SIMULATED_MISSING = (process.argv.find((arg) => arg.startsWith("--simulate=")) ?? "")
  .slice("--simulate=".length)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");

/**
 * The opposite, for the tests that drive the app (test/app.test.ts): a machine with git and no
 * agent at all — a CI runner — still opens, with the shell as its one terminal. Nothing is
 * reported differently; only the verdict is.
 */
const SHELL_SUFFICES = process.argv.includes("--allow-shell-only");

/**
 * Checking an agent spawns it (`checkAgentInstalled`), and on win32 most go through cmd.exe —
 * its own process creation blocks the event loop for as long as Windows (and any antivirus
 * scanning the shim) takes to answer. Dispatched in the same tick, four such blocks merge into
 * one multi-second freeze right at startup (measured in event-loop.log); a tick of daylight
 * between each keeps them as separate, shorter ones instead.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * What has to be on the machine before the app opens: git, because the whole git side is the
 * local CLI, and one of the agents, because the terminals are what tet is for.
 *
 * Nothing is answered from memory here — the dialog this feeds offers a re-check for the user who
 * installs something while it stands (the projects opened afterwards do take the answer given here,
 * see `isAgentInstalled`). Each re-check first looks again for the managers' bin directories
 * (`augmentAgentPath`); a program installed somewhere else, into a folder this process has no way
 * to know of, is only picked up by a restart, and the dialog says so.
 */
export async function checkRequirements(): Promise<Requirements> {
  // Somewhere every machine has and no repository owns: the checks are about the programs,
  // not about a project.
  const cwd = os.tmpdir();
  const installable = AGENTS.filter((agent): agent is InstallableAgent => agent.versionArgs !== undefined);

  // Runs in its own utility process (git-client.ts), so it never blocks this one — started
  // alongside the agent checks below rather than awaited first.
  const gitInstalled = SIMULATED_MISSING.includes(GIT.command) ? Promise.resolve(false) : git.isAvailable().catch(() => false);

  const agentChecks: Promise<Requirement>[] = [];
  for (const agent of installable) {
    const command = agent.executable();
    agentChecks.push(
      (async (): Promise<Requirement> => ({
        name: agent.displayName,
        command,
        installed: !SIMULATED_MISSING.includes(command) && (await checkAgentInstalled(command, agent.versionArgs, cwd)),
        url: agent.installUrl ?? ""
      }))()
    );
    await yieldToLoop();
  }

  const [installed, agents] = await Promise.all([gitInstalled, Promise.all(agentChecks)]);
  return {
    met: installed && (SHELL_SUFFICES || agents.some((agent) => agent.installed)),
    git: { ...GIT, installed },
    agents
  };
}
