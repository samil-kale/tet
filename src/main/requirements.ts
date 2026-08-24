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
 * What has to be on the machine before the app opens: git, because the whole git side is the
 * local CLI, and one of the agents, because the terminals are what tet is for.
 *
 * Nothing is answered from memory here — the dialog this feeds offers a re-check for the user who
 * installs something while it stands (the projects opened afterwards do take the answer given here,
 * see `isAgentInstalled`). What a re-check cannot see is a program installed into a folder this
 * process does not have on its PATH yet; only a restart picks that up, and the dialog says so.
 */
export async function checkRequirements(): Promise<Requirements> {
  // Somewhere every machine has and no repository owns: the checks are about the programs,
  // not about a project.
  const cwd = os.tmpdir();
  const installable = AGENTS.filter((agent): agent is InstallableAgent => agent.versionArgs !== undefined);
  const [installed, agents] = await Promise.all([
    // A git process that could not be started answers the question by rejecting.
    SIMULATED_MISSING.includes(GIT.command) ? false : git.isAvailable().catch(() => false),
    Promise.all(
      installable.map(async (agent): Promise<Requirement> => {
        const command = agent.executable();
        return {
          name: agent.displayName,
          command,
          installed:
            !SIMULATED_MISSING.includes(command) && (await checkAgentInstalled(command, agent.versionArgs, cwd)),
          url: agent.installUrl ?? ""
        };
      })
    )
  ]);
  return {
    met: installed && (SHELL_SUFFICES || agents.some((agent) => agent.installed)),
    git: { ...GIT, installed },
    agents
  };
}
