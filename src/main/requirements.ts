import * as os from "node:os";
import { AGENTS, agentInstalled } from "./agents";
import { worktreesSupported } from "../shared/types/git";
import type { Requirement, Requirements } from "../shared/types/agents";
import { git } from "./git/git-client";
import { isSimulatedMissing } from "./util/simulate";
import { augmentAgentPath } from "./agents/agent-path";
import { findsExecutable } from "./util/process";

const GIT: Omit<Requirement, "installed"> = {
  name: "Git",
  command: "git",
};

/** Only the binary: sign-in and policy are SbxSettingsDialog's; checking them would call Docker. */
const SBX: Omit<Requirement, "installed"> = {
  name: "Docker Sandboxes",
  command: "sbx",
};

/** For the e2e tests: a CI runner with git and no agent still opens, shell only. */
const SHELL_SUFFICES = process.argv.includes("--allow-shell-only");

/**
 * Checking an agent spawns it, on win32 mostly via cmd.exe, whose process creation blocks the event
 * loop. In one tick, such blocks merge into one long startup freeze; a tick between each keeps them
 * apart.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Started one tick apart (yieldToLoop); what the tabs reuse (`agentInstalled`). */
async function checkAgentRequirements(): Promise<Requirement[]> {
  // No repository's directory: the checks are about the programs.
  const cwd = os.tmpdir();
  // The shell has no `install`.
  const installable = AGENTS.filter((agent) => agent.install !== undefined);
  const agentChecks: Promise<Requirement>[] = [];
  for (const agent of installable) {
    agentChecks.push(
      (async (): Promise<Requirement> => ({
        name: agent.displayName,
        command: agent.executable(),
        installed: await agentInstalled(agent, cwd, true),
      }))(),
    );
    await yieldToLoop();
  }
  return Promise.all(agentChecks);
}

/** Whether `command` is there to start: looked up, never started (`findsExecutable`). */
function found(command: string): boolean {
  return !isSimulatedMissing(command) && findsExecutable(command);
}

/**
 * Each agent as the gate sees it: found on PATH. Starting each for its `--version` (on win32 an npm
 * shim through cmd.exe) would hold the whole start for the slowest; one that is there but fails to
 * run says so in its tab, which checks it by starting it (`agentInstalled`).
 */
function agentRequirements(): Requirement[] {
  // The shell has no `install`.
  return AGENTS.filter((agent) => agent.install !== undefined).map((agent) => ({
    name: agent.displayName,
    command: agent.executable(),
    installed: found(agent.executable()),
  }));
}

/**
 * Needed before the app opens: git, and an agent or sbx — a sandboxed tab runs the agent's CLI in
 * its sandbox (AgentPlaces.sbxOnly). Met, ipc/app.ts's `startup:check` opens the workspace; unmet,
 * `RequirementsDialog` is a wall and installs nothing. Never answered from memory: each re-check
 * re-scans the managers' bin dirs (`augmentAgentPath`); an install elsewhere needs a restart.
 * Git alone is started: its version says whether worktrees can be made.
 */
export async function checkRequirements(): Promise<Requirements> {
  // In the git utility process (git-client.ts).
  const gitVersion = isSimulatedMissing(GIT.command) ? Promise.resolve(undefined) : git.version().catch(() => undefined);
  const agents = agentRequirements();
  const sbx = found(SBX.command);
  const version = await gitVersion;
  const installed = version !== undefined;
  return {
    met: installed && (SHELL_SUFFICES || agents.some((agent) => agent.installed) || sbx),
    git: { ...GIT, installed },
    agents,
    sbx: { ...SBX, installed: sbx },
    worktrees: worktreesSupported(version),
  };
}

/**
 * Whether any agent CLI is installed now — deciding sbx-only: add-repository opens the SBX Settings
 * when none is, and SbxSettingsDialog locks on it. Never stored or polled; asked where TET refreshes
 * host state, PATH re-read first since the user may just have installed one (`augmentAgentPath`
 * joins a running call, so beside `sbx:status` it costs one login shell).
 */
export async function anyAgentInstalled(): Promise<boolean> {
  await augmentAgentPath();
  return (await checkAgentRequirements()).some((agent) => agent.installed);
}
