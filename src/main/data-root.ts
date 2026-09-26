import * as os from "node:os";
import * as path from "node:path";
import type { AgentId } from "../shared/types";

/**
 * `~/.tet` on every platform, like the agents' `~/.claude`, `~/.codex`, `~/.pi`: settings,
 * projects and their data (project-dirs.ts), the agents' host setup (agentConfigDir), accounts,
 * logs, the tet-ctl launcher, updates.
 * Electron's `userData` keeps only Chromium's profile. One fixed path lets an sbx organization allow
 * tet's mounted folders with one rule (sbx.ts's readSbxBlockers) and keeps logs out of a roaming
 * Windows profile.
 * `--user-data-dir` (the tests' profile, main.ts) puts both in that folder.
 */
export function resolveDataRoot(userDataArg: string | undefined): string {
  return userDataArg ? path.resolve(userDataArg) : path.join(os.homedir(), ".tet");
}

/** One agent's setup for its host tabs (AgentPaths.agentDir), the same for every project, so kept
 *  once. A sandboxed tab gets its own copy under its project (project-dirs.ts's sandboxDir). */
export function agentConfigDir(dataRoot: string, agentId: AgentId): string {
  return path.join(dataRoot, "agent-config", agentId);
}
