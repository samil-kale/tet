import * as fs from "node:fs";
import * as path from "node:path";
import { sandboxSessionDir } from "./hook-target";

/**
 * Everything an agent tab reads or writes about a project (agentDir) lives in one folder of tet's
 * data folder (data-root.ts), apart from what a sandbox must never see (settings, provider tokens)
 * — so an organization governing sbx allows it with one filesystem rule (sbx.ts's
 * readSbxBlockers), not all of `~/.tet`.
 */
export function agentDataDir(storageRoot: string): string {
  return path.join(storageRoot, "agent-data");
}

/** One agent's own scratch directory for one repository — see AgentPaths.agentDir. */
export function agentDirFor(storageRoot: string, agentId: string, projectId: string): string {
  return path.join(agentDataDir(storageRoot), agentId, projectId);
}

/**
 * Moves what agent data 0.12.1 and older kept elsewhere to where it is now. Before the first spawn,
 * since a running CLI holds paths into it; a sandbox drops its mount of an old path at its next
 * start (sbx.ts's mountAll). What cannot move (a handle Windows holds) is tried again at the next
 * start, and what is already in the new place is left to that.
 */
export function migrateAgentDirs(storageRoot: string): void {
  migrateAgentsFolder(storageRoot);
  migrateSandboxSessions(storageRoot);
}

/** Moves agentDirs from `agent-data/agents/<agent>/<project>` to agentDirFor's, per project. */
function migrateAgentsFolder(storageRoot: string): void {
  const legacy = path.join(agentDataDir(storageRoot), "agents");
  let agentIds: string[];
  try {
    agentIds = fs.readdirSync(legacy);
  } catch {
    return;
  }
  for (const agentId of agentIds) {
    const from = path.join(legacy, agentId);
    try {
      for (const projectId of fs.readdirSync(from)) {
        const target = agentDirFor(storageRoot, agentId, projectId);
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(path.join(from, projectId), target);
        }
      }
      fs.rmdirSync(from);
    } catch (error) {
      console.error(`[tet] could not move ${from} into ${agentDataDir(storageRoot)}:`, error);
    }
  }
  try {
    fs.rmdirSync(legacy);
  } catch {
    // Not empty: something above could not move.
  }
}

/** Moves each agentDir's `sandbox-sessions` to sandboxSessionDir's. */
function migrateSandboxSessions(storageRoot: string): void {
  let agentIds: string[];
  try {
    agentIds = fs.readdirSync(agentDataDir(storageRoot));
  } catch {
    return;
  }
  for (const agentId of agentIds) {
    let projectIds: string[];
    try {
      projectIds = fs.readdirSync(path.join(agentDataDir(storageRoot), agentId));
    } catch {
      continue;
    }
    for (const projectId of projectIds) {
      const agentDir = agentDirFor(storageRoot, agentId, projectId);
      const from = path.join(agentDir, "sandbox-sessions");
      const target = sandboxSessionDir(agentDir);
      if (!fs.existsSync(from) || fs.existsSync(target)) {
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(from, target);
      } catch (error) {
        console.error(`[tet] could not move ${from} to ${target}:`, error);
      }
    }
  }
}
