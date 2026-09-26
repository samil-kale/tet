import { useEffect, useState } from "react";
import type { AgentInfo } from "../../shared/types";

/**
 * Asked once per window, not per view: the list (agents and their flags, `AgentInfo`)
 * cannot change while the process runs, and a `TerminalHost` cannot attach until it has landed.
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
