import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkoutRef } from "../shared/types";
import type { AgentId, CheckoutRef, Project } from "../shared/types";
import { onDisk, relativeInside } from "./path-inside";

/**
 * Everything TET keeps of a project, in one folder of its data folder (data-root.ts):
 *
 * ```
 * projects/<id>/                   id: `tet.id` in the repository's git config
 *   main/                          the main worktree (its checkout is the user's folder)
 *     host/<agent>/                what a host tab of the agent is set up with; never mounted
 *     sandbox/<agent>/             mounted whole into the agent's sandbox, and nothing else of ~/.tet
 *       sessions/                  the host side of the agent's session mounts
 *   worktrees/<key>/               a worktree TET made; the key never changes
 *     checkout/                    the git worktree
 *     host/<agent>/, sandbox/<agent>/
 * ```
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

/** `main/`, or the worktree's `worktrees/<key>/`. */
export function checkoutDataDir(dataRoot: string, ref: CheckoutRef): string {
  const project = projectDir(dataRoot, ref.projectId);
  return ref.worktree === undefined ? path.join(project, "main") : path.join(project, "worktrees", ref.worktree);
}

/** The git worktree TET made under `key`, in on-disk spelling like the paths git reports. */
export function worktreeCheckout(dataRoot: string, projectId: string, key: string): string {
  return path.join(projectsDirOnDisk(dataRoot), projectId, "worktrees", key, "checkout");
}

/** The folder a checkout's terminals and git commands run in. */
export function checkoutPath(dataRoot: string, project: Project, ref: CheckoutRef): string {
  return ref.worktree === undefined ? project.path : worktreeCheckout(dataRoot, project.id, ref.worktree);
}

/** One agent's folder for its host tabs in a checkout — see AgentPaths.agentDir. */
export function hostDir(dataRoot: string, ref: CheckoutRef, agentId: AgentId): string {
  return path.join(checkoutDataDir(dataRoot, ref), "host", agentId);
}

/** One agent's folder for its sandboxed tabs in a checkout, the one TET folder its sandbox mounts. */
export function sandboxDir(dataRoot: string, ref: CheckoutRef, agentId: AgentId): string {
  return path.join(checkoutDataDir(dataRoot, ref), "sandbox", agentId);
}

/** A key no worktree of the project has: 8 hex digits, short enough for a path and a sandbox name. */
export function newWorktreeKey(dataRoot: string, projectId: string): string {
  for (;;) {
    const key = crypto.randomBytes(4).toString("hex");
    if (!fs.existsSync(checkoutDataDir(dataRoot, checkoutRef(projectId, key)))) {
      return key;
    }
  }
}

/** The keys of the worktrees TET made for the project that still have their checkout. */
export function ownedWorktreeKeys(dataRoot: string, projectId: string): string[] {
  const worktrees = path.join(projectDir(dataRoot, projectId), "worktrees");
  let keys: string[];
  try {
    keys = fs.readdirSync(worktrees);
  } catch {
    return [];
  }
  return keys.filter((key) => fs.existsSync(path.join(worktrees, key, "checkout", ".git")));
}

/**
 * The key of a worktree TET made for the project, from its path as git reports it; undefined for any
 * other. A path comparison alone: `Repository.emit` asks it on every refresh.
 */
export function worktreeKeyOf(dataRoot: string, projectId: string, worktreePath: string): string | undefined {
  const inside = relativeInside(path.join(projectsDirOnDisk(dataRoot), projectId, "worktrees"), worktreePath);
  const parts = inside?.split(path.sep);
  return parts?.length === 2 && parts[1] === "checkout" ? parts[0] : undefined;
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
