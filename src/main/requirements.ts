import * as os from "node:os";
import { AGENTS, agentInstalled } from "./agents";
import { worktreesSupported } from "../shared/types/git";
import type { Requirement, Requirements } from "../shared/types/agents";
import { git } from "./git/git-client";
import { readSbxVersion } from "./sbx/sbx-cli";
import { isSimulatedMissing } from "./util/simulate";
import { augmentAgentPath } from "./agents/agent-path";

const GIT: Omit<Requirement, "installed"> = {
  name: "Git",
  command: "git"
};

/** Only the binary: sign-in and policy are SbxSettingsDialog's; checking them would call Docker. */
const SBX: Omit<Requirement, "installed"> = {
  name: "Docker Sandboxes",
  command: "sbx"
};

/** For test/app.test.ts: a CI runner with git and no agent still opens, shell only. */
const SHELL_SUFFICES = process.argv.includes("--allow-shell-only");

/**
 * Checking an agent spawns it, on win32 mostly via cmd.exe, whose process creation blocks the event
 * loop. In one tick, such blocks merge into one long startup freeze; a tick between each keeps them
 * apart.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Checked one tick apart (yieldToLoop). */
async function checkAgentRequirements(cwd: string): Promise<Requirement[]> {
  // The shell has no `install`.
  const installable = AGENTS.filter((agent) => agent.install !== undefined);
  const agentChecks: Promise<Requirement>[] = [];
  for (const agent of installable) {
    agentChecks.push(
      (async (): Promise<Requirement> => ({
        name: agent.displayName,
        command: agent.executable(),
        installed: await agentInstalled(agent, cwd, true)
      }))()
    );
    await yieldToLoop();
  }
  return Promise.all(agentChecks);
}

/**
 * Needed before the app opens: git, and an agent or sbx — a sandboxed tab runs the agent's CLI in
 * its container (session-manager's AgentRuntime.sbxOnly). Met, ipc/app.ts's `startup:check` opens the
 * workspace. Never answered from memory: each re-check
 * re-scans the managers' bin dirs (`augmentAgentPath`); an install elsewhere needs a restart.
 * Projects opened afterwards reuse this answer (`agentInstalled`).
 */
export async function checkRequirements(): Promise<Requirements> {
  // No repository's directory: the checks are about the programs.
  const cwd = os.tmpdir();

  // In the git utility process (git-client.ts), so started alongside the agent checks.
  const gitVersion = isSimulatedMissing(GIT.command) ? Promise.resolve(undefined) : git.version().catch(() => undefined);

  // A tick ahead of the agents: on win32 process creations hurt when sharing a tick (yieldToLoop).
  const sbxInstalled = readSbxVersion().then((sbxVersion) => sbxVersion !== undefined);
  await yieldToLoop();

  const agents = await checkAgentRequirements(cwd);
  const [version, sbx] = await Promise.all([gitVersion, sbxInstalled]);
  const installed = version !== undefined;
  return {
    met: installed && (SHELL_SUFFICES || agents.some((agent) => agent.installed) || sbx),
    git: { ...GIT, installed },
    agents,
    sbx: { ...SBX, installed: sbx },
    worktrees: worktreesSupported(version)
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
