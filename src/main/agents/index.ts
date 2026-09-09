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

/** The first installed agent with `askArgs`, in registration order (the shell has none). */
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
