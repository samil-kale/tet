import * as path from "node:path";

/**
 * Everything an agent tab of tet's own reads or writes about a project — each agent's generated
 * setup and records (agentDir) and the shell context — lives under one folder of tet's data folder
 * (data-root.ts), apart from what a sandbox must never see (settings, provider tokens). An
 * organization governing sbx then allows tet's data with one filesystem rule for this folder
 * (sbx.ts's readSbxBlockers), not for all of `~/.tet`.
 */
export function agentDataDir(storageRoot: string): string {
  return path.join(storageRoot, "agent-data");
}

/** One agent's own scratch directory for one repository — see AgentPaths.agentDir. */
export function agentDirFor(storageRoot: string, agentId: string, projectId: string): string {
  return path.join(agentDataDir(storageRoot), "agents", agentId, projectId);
}

/** Where a project's context file and shell transcript live — see ShellContext. */
export function contextDirFor(storageRoot: string, projectId: string): string {
  return path.join(agentDataDir(storageRoot), "projects", projectId);
}
