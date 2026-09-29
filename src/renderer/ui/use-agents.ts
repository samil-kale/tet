import { useEffect, useState } from "react";
import type { AgentId, AgentInfo } from "../../shared/types/agents";

/**
 * Asked once per window, not per view: the list (agents and their flags, `AgentInfo`)
 * cannot change while the process runs.
 */
let agentsPromise: Promise<AgentInfo[]> | undefined;
let agentsList: AgentInfo[] = [];

export function useAgents(): AgentInfo[] {
  const [agents, setAgents] = useState<AgentInfo[]>(agentsList);
  useEffect(() => {
    let cancelled = false;
    agentsPromise ??= window.tet.agents.list().then((list) => (agentsList = list));
    void agentsPromise.then((list) => {
      if (!cancelled) {
        setAgents(list);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return agents;
}

/** An agent's entry; undefined while the list has not landed. */
export function agentInfo(agents: readonly AgentInfo[], id: AgentId): AgentInfo | undefined {
  return agents.find((agent) => agent.id === id);
}

/** An agent's name as the user reads it; its id while the list has not landed. */
export function agentName(agents: readonly AgentInfo[], id: AgentId): string {
  return agentInfo(agents, id)?.displayName ?? id;
}
