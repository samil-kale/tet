import type { AgentPlaces } from "./place-resolver";
import type { ReconcileScheduler } from "./reconcile-scheduler";

/** Per-agent state within one repository or worktree. */
export interface AgentRuntime extends AgentPlaces {
  /** Startable here: the host executable, or the repository's or worktree's sandbox standing in
   *  (sbxOnly). */
  startable: boolean;
  /** Resolves once the version check, the host setup (HostSetups) and initial listing are done. */
  ready: Promise<void>;
  stopWatching?: () => void;
  /** Only for an agent with sessions: no other has any to re-list. */
  reconciler?: ReconcileScheduler;
}
