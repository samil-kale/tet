import * as os from "node:os";
import { AGENTS } from "./agents";
import type { AgentDefinition } from "./agents/agent";
import type { Requirement, Requirements } from "../shared/types";
import { git } from "./git/git-client";
import { isSbxInstalled } from "./sbx";
import { augmentAgentPath } from "./terminals/agent-path";
import { checkAgentInstalled } from "./terminals/terminal-session";

/** An agent that has to be installed; the shell has no `versionArgs` and is always there. */
type InstallableAgent = AgentDefinition & { versionArgs: string[] };

const GIT: Omit<Requirement, "installed"> = {
  name: "Git",
  command: "git"
};

/** Named as the sbx dialog names it. Only the binary is asked for here: signing in and the network
 *  policy are what SbxSettingsDialog walks the user through, and asking for them would make the
 *  startup check talk to Docker. */
const SBX: Omit<Requirement, "installed"> = {
  name: "Docker Sandboxes",
  command: "sbx"
};

/** The commands `--simulate` names, reported missing however installed they are, so the dialog is
 *  reachable on a machine that has everything: `npm start -- --simulate=git,claude` (npm's own
 *  `--` hands the flag past the script to electron). */
const SIMULATED_MISSING = (process.argv.find((arg) => arg.startsWith("--simulate=")) ?? "")
  .slice("--simulate=".length)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");

/** The opposite, for test/app.test.ts: a machine with git and no agent at all — a CI runner —
 *  still opens, with the shell as its one terminal. Only the verdict changes. */
const SHELL_SUFFICES = process.argv.includes("--allow-shell-only");

/**
 * Checking an agent spawns it (`checkAgentInstalled`), and on win32 most go through cmd.exe, whose
 * process creation blocks the event loop for as long as Windows (and any antivirus scanning the
 * shim) takes. Dispatched in the same tick, four such blocks merge into one multi-second freeze at
 * startup (measured in event-loop.log); a tick of daylight between each keeps them separate.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Every installable agent, checked one tick apart — see yieldToLoop. */
async function checkAgentRequirements(cwd: string): Promise<Requirement[]> {
  const installable = AGENTS.filter((agent): agent is InstallableAgent => agent.versionArgs !== undefined);
  const agentChecks: Promise<Requirement>[] = [];
  for (const agent of installable) {
    const command = agent.executable();
    agentChecks.push(
      (async (): Promise<Requirement> => ({
        name: agent.displayName,
        command,
        installed: !SIMULATED_MISSING.includes(command) && (await checkAgentInstalled(command, agent.versionArgs, cwd))
      }))()
    );
    await yieldToLoop();
  }
  return Promise.all(agentChecks);
}

/**
 * What has to be on the machine before the app opens: git, because the whole git side is the local
 * CLI, and either one of the agents or sbx — a sandboxed tab runs the agent's CLI inside its
 * container, so a machine with sbx alone can still work (see session-manager's AgentRuntime.sbxOnly).
 * Nothing is answered from memory here — the dialog this feeds offers a re-check, and each one
 * looks again for the managers' bin directories (`augmentAgentPath`); a program installed into a
 * folder this process cannot know of needs a restart, and the dialog says so. The projects opened
 * afterwards do take the answer given here (`isAgentInstalled`).
 */
export async function checkRequirements(): Promise<Requirements> {
  // Somewhere every machine has and no repository owns: the checks are about the programs.
  const cwd = os.tmpdir();

  // Runs in its own utility process (git-client.ts), so it never blocks this one — started
  // alongside the agent checks rather than awaited first.
  const gitInstalled = SIMULATED_MISSING.includes(GIT.command) ? Promise.resolve(false) : git.isAvailable().catch(() => false);

  // Started before the agents and a tick ahead of them: sbx is one more process creation, and
  // what makes those hurt on win32 is sharing a tick, not running at once (see yieldToLoop).
  const sbxInstalled = SIMULATED_MISSING.includes(SBX.command) ? Promise.resolve(false) : isSbxInstalled();
  await yieldToLoop();

  const agents = await checkAgentRequirements(cwd);
  const [installed, sbx] = await Promise.all([gitInstalled, sbxInstalled]);
  return {
    met: installed && (SHELL_SUFFICES || agents.some((agent) => agent.installed) || sbx),
    git: { ...GIT, installed },
    agents,
    sbx: { ...SBX, installed: sbx }
  };
}

/**
 * Whether any agent CLI is on this machine right now — what decides that a project runs sbx-only:
 * the add-repository flow opens the sbx settings for a new project when nothing is installed, and
 * SbxSettingsDialog locks itself on the same answer. Never stored, and never polled: it is asked
 * where tet already refreshes host state, and PATH is re-read first because the point of asking
 * again is that the user has just installed something (`augmentAgentPath` joins a running call
 * rather than starting a second login shell, so asking beside `sbx:status` costs one).
 */
export async function anyAgentInstalled(cwd = os.tmpdir()): Promise<boolean> {
  await augmentAgentPath();
  return (await checkAgentRequirements(cwd)).some((agent) => agent.installed);
}
