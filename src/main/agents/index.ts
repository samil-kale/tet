import * as os from "node:os";
import { checkAgentInstalled, isAgentInstalled } from "../terminals/terminal-session";
import type { AgentId, AgentInfo } from "../../shared/types";
import { hasSandbox } from "./agent";
import type { AgentAsk, AgentDefinition, SandboxedAgent } from "./agent";
import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";
import { piAgent } from "./pi";
import { shellAgent } from "./shell";

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

/** The first installed agent that can `ask`, in registration order. */
export async function findAskableAgent(
  cwd: string
): Promise<{ executable: string; agent: AgentDefinition; ask: AgentAsk } | undefined> {
  for (const agent of AGENTS) {
    if (!agent.ask || !agent.install) {
      continue;
    }
    if (await agentInstalled(agent, cwd)) {
      return { executable: agent.executable(), agent, ask: agent.ask };
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
          .catch((error: unknown) => console.error(`[tet] could not delete ${agent.displayName} session ${id}:`, error));
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
    sandboxed: hasSandbox(agent)
  }));
}
