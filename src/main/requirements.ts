import * as os from "node:os";
import { AGENTS } from "./agents";
import type { AgentDefinition } from "./agents/agent";
import type { Requirement, Requirements } from "../shared/types";
import { git } from "./git/git-client";
import { isSbxInstalled } from "./sbx";
import { augmentAgentPath } from "./terminals/agent-path";
import { checkAgentInstalled } from "./terminals/terminal-session";

/** The shell has no `versionArgs`. */
type InstallableAgent = AgentDefinition & { versionArgs: string[] };

const GIT: Omit<Requirement, "installed"> = {
  name: "Git",
  command: "git"
};

/** Only the binary: sign-in and policy are SbxSettingsDialog's; checking them would call Docker. */
const SBX: Omit<Requirement, "installed"> = {
  name: "Docker Sandboxes",
  command: "sbx"
};

/** Commands reported missing regardless, to reach the dialog on a full machine:
 *  `npm start -- --simulate=git,claude`. */
const SIMULATED_MISSING = (process.argv.find((arg) => arg.startsWith("--simulate=")) ?? "")
  .slice("--simulate=".length)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");

/** For test/app.test.ts: a CI runner with git and no agent still opens, shell only. */
const SHELL_SUFFICES = process.argv.includes("--allow-shell-only");

/**
 * Checking an agent spawns it, on win32 mostly via cmd.exe, whose process creation blocks the event
 * loop (antivirus included). In one tick, four such blocks merge into a multi-second startup freeze
 * (measured in event-loop.log); a tick between each keeps them apart.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Checked one tick apart (yieldToLoop). */
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
 * Needed before the app opens: git, and an agent or sbx — a sandboxed tab runs the agent's CLI in
 * its container (session-manager's AgentRuntime.sbxOnly). Never answered from memory: each re-check
 * re-scans the managers' bin dirs (`augmentAgentPath`); an install elsewhere needs a restart.
 * Projects opened afterwards reuse this answer (`isAgentInstalled`).
 */
export async function checkRequirements(): Promise<Requirements> {
  // No repository's directory: the checks are about the programs.
  const cwd = os.tmpdir();

  // In the git utility process (git-client.ts), so started alongside the agent checks.
  const gitInstalled = SIMULATED_MISSING.includes(GIT.command) ? Promise.resolve(false) : git.isAvailable().catch(() => false);

  // A tick ahead of the agents: on win32 process creations hurt when sharing a tick (yieldToLoop).
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
 * Whether any agent CLI is installed now — deciding sbx-only: add-repository opens the sbx settings
 * when none is, and SbxSettingsDialog locks on it. Never stored or polled; asked where tet refreshes
 * host state, PATH re-read first since the user may just have installed one (`augmentAgentPath`
 * joins a running call, so beside `sbx:status` it costs one login shell).
 */
export async function anyAgentInstalled(): Promise<boolean> {
  await augmentAgentPath();
  return (await checkAgentRequirements(os.tmpdir())).some((agent) => agent.installed);
}
