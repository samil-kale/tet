import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentId, ProjectRef, Project } from "../shared/types";
import { onDisk, relativeInside } from "./path-inside";

/**
 * Everything TET keeps of a project, in one folder of its data folder (data-root.ts), ordered by
 * what it holds:
 *
 * ```
 * projects/<id>/                   id: `tet.id` in the repository's git config
 *   sandboxes/                     what the sandboxes mount, and nothing else of ~/.tet
 *     repository/<agent>/          the repository's sandbox of the agent
 *       sessions/                  the host side of the agent's session mounts
 *     <key>/<agent>/               a worktree's
 *   worktrees/<key>/               a git worktree TET made; the key never changes
 * ```
 *
 * A host tab's setup is the same for every project and lies once in `config/<agent>/`
 * (data-root.ts's agentConfigDir); only a sandbox, which sees nothing but its own folder, needs its
 * copy here.
 *
 * Never anything a sandbox must not see (settings, tokens, sbx values): an organization governing
 * sbx allows the whole folder with one rule (sbx.ts's readSbxBlockers).
 */
export function projectsDir(dataRoot: string): string {
  return path.join(dataRoot, "projects");
}

export function projectDir(dataRoot: string, projectId: string): string {
  return path.join(projectsDir(dataRoot), projectId);
}

/** The repository's or a worktree's sandbox folders, one per agent: `sandboxes/repository/` or
 *  `sandboxes/<key>/` (a key is 8 hex digits, never "repository"). */
function sandboxesDir(dataRoot: string, ref: ProjectRef): string {
  return path.join(projectDir(dataRoot, ref.projectId), "sandboxes", ref.worktree ?? "repository");
}

/** The git worktree TET made under `key`, in on-disk spelling like the paths git reports. */
export function worktreeDir(dataRoot: string, projectId: string, key: string): string {
  return path.join(projectsDirOnDisk(dataRoot), projectId, "worktrees", key);
}

/** Everything TET keeps of a worktree: its files and its sandbox folders. */
export function worktreeFolders(dataRoot: string, projectId: string, key: string): string[] {
  return [worktreeDir(dataRoot, projectId, key), sandboxesDir(dataRoot, { projectId, worktree: key })];
}

/** The folder the repository's or a worktree's terminals and git commands run in. */
export function projectRefPath(dataRoot: string, project: Project, ref: ProjectRef): string {
  return ref.worktree === undefined ? project.path : worktreeDir(dataRoot, project.id, ref.worktree);
}

/** One agent's folder for its sandboxed tabs in the repository or a worktree, the one TET folder
 *  its sandbox mounts. */
export function sandboxDir(dataRoot: string, ref: ProjectRef, agentId: AgentId): string {
  return path.join(sandboxesDir(dataRoot, ref), agentId);
}

/** A key no worktree of the project has: 8 hex digits, short enough for a path and a sandbox name. */
export function newWorktreeKey(dataRoot: string, projectId: string): string {
  for (;;) {
    const key = crypto.randomBytes(4).toString("hex");
    if (!worktreeFolders(dataRoot, projectId, key).some((folder) => fs.existsSync(folder))) {
      return key;
    }
  }
}

/** The keys of the worktrees TET made for the project that are still there. */
export function ownedWorktreeKeys(dataRoot: string, projectId: string): string[] {
  const worktrees = path.join(projectDir(dataRoot, projectId), "worktrees");
  let keys: string[];
  try {
    keys = fs.readdirSync(worktrees);
  } catch {
    return [];
  }
  return keys.filter((key) => fs.existsSync(path.join(worktrees, key, ".git")));
}

/**
 * The key of a worktree TET made for the project, from its path as git reports it; undefined for any
 * other. A path comparison alone: `Repository.emit` asks it on every refresh.
 */
export function worktreeKeyOf(dataRoot: string, projectId: string, worktreePath: string): string | undefined {
  const inside = relativeInside(path.join(projectsDirOnDisk(dataRoot), projectId, "worktrees"), worktreePath);
  return inside && !inside.includes(path.sep) ? inside : undefined;
}

/** `projectsDir` in on-disk spelling per data folder: created and resolved once, as worktreeKeyOf
 *  runs on every refresh. */
const projectsOnDisk = new Map<string, string>();

function projectsDirOnDisk(dataRoot: string): string {
  let folder = projectsOnDisk.get(dataRoot);
  if (folder === undefined) {
    fs.mkdirSync(projectsDir(dataRoot), { recursive: true });
    folder = onDisk(projectsDir(dataRoot));
    projectsOnDisk.set(dataRoot, folder);
  }
  return folder;
}
