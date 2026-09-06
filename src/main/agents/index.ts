import { isAgentInstalled } from "../terminals/terminal-session";
import type { AgentId, AgentInfo } from "../../shared/types";
import type { AgentDefinition } from "./agent";
import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";
import { opencodeAgent } from "./opencode";
import { piAgent } from "./pi";
import { shellAgent } from "./shell";

/** Registration order; also the order of the "new terminal" menu. */
export const AGENTS: AgentDefinition[] = [claudeAgent, opencodeAgent, codexAgent, piAgent, shellAgent];

/**
 * Every agent's one-time setup, before the first project opens — see AgentDefinition.prepareApp.
 * The one call the main process makes into this layer that is about no repository at all.
 */
export function prepareAgents(storageRoot: string): void {
  for (const agent of AGENTS) {
    agent.prepareApp?.(storageRoot);
  }
}

/**
 * The first installed agent that can be asked a question without a terminal, in registration
 * order — the shell has no `askArgs` and is skipped by that alone. Which one it is stays this
 * registry's knowledge: a caller only wants *someone* to put a question to.
 */
export async function findAskableAgent(
  cwd: string
): Promise<{ executable: string; agent: AgentDefinition } | undefined> {
  for (const agent of AGENTS) {
    if (!agent.askArgs || !agent.versionArgs) {
      continue;
    }
    const executable = agent.executable();
    if (await isAgentInstalled(executable, agent.versionArgs, cwd)) {
      return { executable, agent };
    }
  }
  return undefined;
}

export function getAgent(id: AgentId): AgentDefinition {
  const agent = AGENTS.find((candidate) => candidate.id === id);
  if (!agent) {
    throw new Error(`Unknown agent: ${id}`);
  }
  return agent;
}

export function listAgents(): AgentInfo[] {
  return AGENTS.map((agent) => ({
    id: agent.id,
    displayName: agent.displayName,
    hasSessions: agent.sessions !== undefined,
    plainCtrlCKills: agent.plainCtrlCKills === true,
    takesRightMouse: agent.takesRightMouse === true,
    swapsBlueMagenta: agent.swapsBlueMagenta === true
  }));
}
