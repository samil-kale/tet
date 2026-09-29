import * as os from "node:os";
import { checkAgentInstalled, isAgentInstalled } from "./install-check";
import { errorMessage } from "../../shared/errors";
import type { AgentId, AgentInfo, AskModelsResult } from "../../shared/types/agents";
import { hasSandbox } from "./agent";
import type { AgentDefinition, SandboxedAgent } from "./agent";
import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";
import { piAgent } from "./pi";
import { shellAgent } from "./shell";
import { logError } from "../util/error-log";

/** Also the order of the "new terminal" menu. */
export const AGENTS: AgentDefinition[] = [claudeAgent, codexAgent, piAgent, shellAgent];

/** The agents that run in an sbx sandbox: those with `sandbox`, in registration order. */
export const SANDBOXED_AGENTS: SandboxedAgent[] = AGENTS.filter(hasSandbox);

/**
 * Whether `agent`'s CLI answers its version check here; the shell has none and always does. The
 * last answer is reused unless `fresh` (the requirements check, which follows new installs).
 */
export function agentInstalled(agent: AgentDefinition, cwd: string, fresh = false): Promise<boolean> {
  if (!agent.install) {
    return Promise.resolve(true);
  }
  const check = fresh ? checkAgentInstalled : isAgentInstalled;
  return check(agent.executable(), agent.install.versionArgs, cwd);
}

/** The installed agents that can `ask`, in registration order. */
export async function listAskableAgents(cwd: string): Promise<AgentId[]> {
  const askable = AGENTS.filter((agent) => agent.ask && agent.install);
  const installed = await Promise.all(askable.map((agent) => agentInstalled(agent, cwd)));
  return askable.filter((_, index) => installed[index]).map((agent) => agent.id);
}

/** The models `agent` answers with at `cwd`, for the commit prompt and `tet-ctl`; an agent not
 *  installed there, or one whose listing fails, answers why. */
export async function listAskModels(agent: AgentDefinition, cwd: string): Promise<AskModelsResult> {
  if (!agent.ask) {
    return { models: [] };
  }
  if (!(await agentInstalled(agent, cwd))) {
    return { models: [], error: `${agent.displayName} is not installed` };
  }
  try {
    return { models: await agent.ask.models(agent.executable(), cwd) };
  } catch (error) {
    return { models: [], error: `Could not list ${agent.displayName}'s models: ${errorMessage(error)}` };
  }
}

export function getAgent(id: AgentId): AgentDefinition {
  const agent = AGENTS.find((candidate) => candidate.id === id);
  if (!agent) {
    throw new Error(`Unknown agent: ${id}`);
  }
  return agent;
}

/** Deletes every session the agents keep on this machine for `cwd`: a worktree TET deleted, whose
 *  sandboxes' sessions went with its folder in `~/.tet`. What fails is logged — the worktree is
 *  gone either way. */
export async function removeAllSessions(cwd: string): Promise<void> {
  await Promise.all(
    AGENTS.map(async (agent) => {
      const sessions = agent.sessions;
      if (!sessions) {
        return;
      }
      for (const { id } of await sessions.list(cwd)) {
        await sessions
          .remove(agent.executable(), cwd, id)
          .catch((error: unknown) => logError(`could not delete ${agent.displayName} session ${id}`, error));
      }
    })
  );
}

/** `tet-ctl list-agents`' answer: every agent with whether it is installed (agentInstalled). */
export function listInstalledAgents(): Promise<{ id: AgentId; name: string; installed: boolean }[]> {
  return Promise.all(
    AGENTS.map(async (agent) => ({ id: agent.id, name: agent.displayName, installed: await agentInstalled(agent, os.tmpdir()) }))
  );
}

export function listAgents(): AgentInfo[] {
  return AGENTS.map((agent) => ({
    id: agent.id,
    displayName: agent.displayName,
    icon: agent.icon,
    hasSessions: agent.sessions !== undefined,
    takesPrompt: agent.terminal !== undefined,
    shiftEnter: agent.terminal?.shiftEnter,
    sandboxed: hasSandbox(agent)
  }));
}
