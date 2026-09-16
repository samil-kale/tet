import * as path from "node:path";

/**
 * Everything an agent tab reads or writes about a project (agentDir, the shell context) lives in
 * one folder of tet's data folder (data-root.ts), apart from what a sandbox must never see
 * (settings, provider tokens) — so an organization governing sbx allows it with one filesystem
 * rule (sbx.ts's readSbxBlockers), not all of `~/.tet`.
 */
export function agentDataDir(storageRoot: string): string {
  return path.join(storageRoot, "agent-data");
}

/** One agent's own scratch directory for one repository — see AgentPaths.agentDir. */
export function agentDirFor(storageRoot: string, agentId: string, projectId: string): string {
  return path.join(agentDataDir(storageRoot), "agents", agentId, projectId);
}

/** Where a project's context file lives — see ShellContext. */
export function contextDirFor(storageRoot: string, projectId: string): string {
  return path.join(agentDataDir(storageRoot), "projects", projectId);
}
