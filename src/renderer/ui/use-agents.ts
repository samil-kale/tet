import { useEffect, useState } from "react";
import type { AgentInfo } from "../../shared/types";

/**
 * Asked once for the window, not once per view: the list is a fact about the process (the
 * agents and their measured flags, see `AgentInfo`) and cannot change while it runs, yet every
 * project's pane and the settings dialog each issued the same IPC and each started out empty —
 * and a `TerminalHost` cannot attach until its pane's own copy has landed.
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
