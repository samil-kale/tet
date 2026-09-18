import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { worktreeBase } from "../shared/types";
import type { AddRepositoryResult, GitActionResult, Project, WorktreeRef } from "../shared/types";
import type { ControlRecords } from "./control/control-records";
import { git } from "./git/git-client";
import { readMainWorktree } from "./git/linked-git-dir";
import type { Repository, RepositoryManager } from "./git/repository";
import { removeProjectSandboxes } from "./sbx";
import type { SbxSecretStore } from "./sbx-secrets";
import type { SessionManagerRegistry } from "./terminals/session-manager";

/** What opening and closing a project takes — the same singletons ipc.ts holds. */
export interface ProjectDeps {
  store: ProjectStore;
  repositories: RepositoryManager;
  sessions: SessionManagerRegistry;
  records: ControlRecords;
  sbxSecrets: SbxSecretStore;
  openProject: (project: Project) => void;
  /** TET's data folder (data-root.ts), holding the worktrees tet creates. */
  dataRoot: string;
  /** Tells the window which project to activate or forget, as the control channel does. */
  projectsChanged: (change: { added?: string; removed?: string }) => void;
}

/**
 * Opens a folder as a project, shared by the add-repository dialog (`projects:open-path`) and the
 * control channel. A stored project whose folder is gone watches and spawns nothing, with a notice
 * per action.
 */
export async function addProject({ store, openProject }: ProjectDeps, directory: string): Promise<AddRepositoryResult> {
  if (!(await fs.promises.stat(directory).then((stat) => stat.isDirectory(), () => false))) {
    return { error: `${directory} is not a folder` };
  }
  // Picking a subdirectory opens the repository itself: git reports paths relative to the root.
  const project = store.add((await git.resolveRoot(directory).catch(() => undefined)) ?? directory);
  openProject(project);
  return { project };
}

/** Resolves once the project's sessions and git commands have ended — a worktree's folder is
 *  removed or moved only then. */
export function removeProject(
  { store, repositories, sessions, records, sbxSecrets }: ProjectDeps,
  projectId: string
): Promise<void> {
  // The project leaves the window at once; its sessions still end by themselves
  // (TerminalSession.stop). Its records go once they have: a stopping tab still prints.
  const sessionsEnded = sessions.close(projectId).finally(() => records.forgetProject(projectId));
  const gitEnded = repositories.close(projectId);
  store.remove(projectId);
  // Reopened, the folder is a new project with new sandboxes (sbx.ts's sandboxName).
  sbxSecrets.forgetProject(projectId);
  return Promise.all([sessionsEnded, gitEnded]).then(() => undefined);
}

/**
 * A worktree's folder name, as GitHub Desktop's `safeDirectoryName` — except that a "/" (a branch
 * like `feature/x`) makes no subfolder, so the folder's name is the project row's.
 */
function worktreeFolderName(name: string): string {
  const unsafe = process.platform === "win32" ? /[\\/<>:"|?*]/g : /[\\/]/g;
  return name.trim().replace(unsafe, "-");
}

/**
 * A folder in on-disk spelling, as `readWorktrees` and `readMainWorktree` give it: a project's path
 * is stored so, or string comparisons with theirs miss — a Windows 8.3 name, macOS's `/var`, a
 * junction or a symlink (measured with a junction). As written while the folder does not exist.
 */
function onDisk(folder: string): string {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return path.resolve(folder);
  }
}

/**
 * The repository a worktree command runs through: an open project of the same repository — its
 * main worktree first, else another of its worktrees — so the command takes that project's action
 * slot (Repository.runAction) and refreshes it after. Not `except`, the worktree being moved or
 * deleted: its project closes first. Undefined when none is open.
 */
function repositoryFor(deps: ProjectDeps, mainPath: string, except?: string): Repository | undefined {
  const excluded = except === undefined ? undefined : onDisk(except);
  const candidates = deps.store
    .list()
    .filter((project) => (project.mainPath ?? project.path) === mainPath && onDisk(project.path) !== excluded)
    .sort((a, b) => Number(b.path === mainPath) - Number(a.path === mainPath));
  return candidates.map((project) => deps.repositories.get(project.id)).find((repository) => repository !== undefined);
}

/** When `repositoryFor` finds none. */
function noRepository(mainPath: string, action: string): GitActionResult {
  return { ok: false, error: `Open ${path.basename(mainPath)} to ${action} this worktree` };
}

/**
 * Creates a worktree of the project's repository with a new branch of its own, and opens it as a
 * project under its main worktree's row. Worktree and branch share the name: the folder is the
 * branch's. The branch starts at the default branch (`worktreeBase`), as most worktree tools
 * start it; refs are shared, so the project it was asked in knows it, and runs it.
 */
export async function addWorktree(deps: ProjectDeps, projectId: string, branch: string): Promise<AddRepositoryResult> {
  const project = deps.store.get(projectId);
  const repository = deps.repositories.get(projectId);
  if (!project || !repository) {
    return { error: "Project not found" };
  }
  const base = worktreeBase(repository.getState());
  if (!base) {
    return { error: "There is no branch to start a worktree at" };
  }
  const mainPath = project.mainPath ?? project.path;
  // `~/.tet/worktrees/<repository>-<hash>/<branch>`: the hash of its path keeps two repositories of
  // one name apart, which would otherwise share their worktrees' folder.
  const hash = createHash("sha1").update(mainPath).digest("hex").slice(0, 8);
  const repositoryFolder = `${path.basename(mainPath)}-${hash}`;
  const target = path.join(deps.dataRoot, "worktrees", repositoryFolder, worktreeFolderName(branch));
  const result = await repository.addWorktree(target, branch.trim(), base);
  if (!result.ok) {
    return { error: result.error || "Creating the worktree failed" };
  }
  const added = deps.store.add(onDisk(target));
  deps.openProject(added);
  deps.projectsChanged({ added: added.id });
  return { project: added };
}

/**
 * Runs a git command on the worktree's folder with its project closed, if it is one: an open
 * terminal holds the folder on Windows, and git would move or delete it half. The sessions are
 * waited for. The project then opens at `reopenAt` — the old path after a failure, since its
 * terminals are gone either way; none after a delete. A new project: its sandboxes are named by the
 * old id, which never comes back, so they go too. Its secret values move to the new id — tet.json
 * came along with the folder, and a rebuilt sandbox is seeded from them.
 */
async function withWorktreeClosed(
  deps: ProjectDeps,
  worktreePath: string,
  command: () => Promise<GitActionResult>,
  reopenAt: (result: GitActionResult) => string | undefined
): Promise<GitActionResult> {
  const folder = onDisk(worktreePath);
  const project = deps.store.list().find((entry) => onDisk(entry.path) === folder);
  const secrets = project ? deps.sbxSecrets.encrypted(project.id) : {};
  if (project) {
    await removeProject(deps, project.id);
    void removeProjectSandboxes(project.id);
  }
  const result = await command();
  if (project) {
    const target = reopenAt(result);
    const reopened = target === undefined ? undefined : deps.store.add(onDisk(target));
    if (reopened) {
      deps.sbxSecrets.restore(reopened.id, secrets);
      deps.openProject(reopened);
    }
    deps.projectsChanged({ removed: project.id, added: reopened?.id });
  }
  return result;
}

/** The branch a worktree has checked out, off the disk; none while detached or unknown. */
async function worktreeBranch(worktree: WorktreeRef): Promise<string | undefined> {
  const folder = onDisk(worktree.path);
  const worktrees = await git.readWorktrees(worktree.mainPath).catch(() => []);
  return worktrees.find((entry) => entry.path === folder)?.branch;
}

/**
 * Deletes the worktree and its branch, which tet couples: its changes are asked about first —
 * answered as `uncommitted` before anything is closed — and forced once confirmed; a folder already
 * gone is pruned. The branch goes after the worktree (git refuses one checked out), and with
 * `onRemote` its upstream too, as a branch's own delete does.
 */
export async function deleteWorktree(
  deps: ProjectDeps,
  worktree: WorktreeRef,
  { force, onRemote }: { force: boolean; onRemote: boolean }
): Promise<GitActionResult> {
  const { path: worktreePath, mainPath } = worktree;
  const repository = repositoryFor(deps, mainPath, worktreePath);
  if (!repository) {
    return noRepository(mainPath, "delete");
  }
  const branch = await worktreeBranch(worktree);
  const gone = !fs.existsSync(worktreePath);
  const uncommitted = async (): Promise<boolean> => !gone && !force && (await git.hasChanges(worktreePath));
  if (await uncommitted()) {
    return { ok: false, uncommitted: true };
  }
  // One hold of the repository: a command running elsewhere refuses this before the project closes.
  return repository.exclusive(async () => {
    const result = await withWorktreeClosed(
      deps,
      worktreePath,
      // Asked again with its terminals gone: one may have written meanwhile, and git would refuse
      // without the question being put.
      async () =>
        (await uncommitted())
          ? { ok: false, uncommitted: true }
          : gone
            ? repository.pruneWorktrees()
            : repository.removeWorktree(worktreePath, force),
      (outcome) => (outcome.ok ? undefined : worktreePath)
    );
    if (!result.ok || branch === undefined) {
      return result;
    }
    return repository.deleteBranch(branch, onRemote);
  });
}

/**
 * Renames the worktree's branch and its folder with it (`git worktree move`, beside itself); an open
 * project opens again at the new path. The branch first — a taken name fails before anything is
 * closed — and back again when the folder cannot move.
 */
export async function renameWorktree(deps: ProjectDeps, worktree: WorktreeRef, branch: string): Promise<GitActionResult> {
  const { path: worktreePath, mainPath } = worktree;
  const repository = repositoryFor(deps, mainPath, worktreePath);
  if (!repository) {
    return noRepository(mainPath, "rename");
  }
  const from = await worktreeBranch(worktree);
  const to = branch.trim();
  // One hold of the repository, as deleteWorktree's: nothing can take it between the branch's
  // rename and the folder's, or the rename back.
  return repository.exclusive(async () => {
    if (from !== undefined) {
      const renamed = await repository.renameBranch(from, to);
      if (!renamed.ok) {
        return renamed;
      }
    }
    const folder = onDisk(worktreePath);
    const target = path.join(path.dirname(folder), worktreeFolderName(to));
    // The same folder, e.g. `feature/x` renamed to `feature-x`: nothing to move, nothing to close.
    if (target === folder) {
      return { ok: true };
    }
    // By case alone git cannot move a folder onto itself (measured: "Invalid argument"), so through
    // a name of its own first.
    const byCaseAlone = target.toLowerCase() === folder.toLowerCase();
    const moved = await withWorktreeClosed(
      deps,
      folder,
      async () => {
        if (!byCaseAlone) {
          return repository.moveWorktree(folder, target);
        }
        const between = `${target}.tet-rename`;
        const first = await repository.moveWorktree(folder, between);
        return first.ok ? repository.moveWorktree(between, target) : first;
      },
      (outcome) => (outcome.ok ? target : folder)
    );
    if (!moved.ok && from !== undefined) {
      await repository.renameBranch(to, from);
    }
    return moved;
  });
}

/** The open repositories, persisted so the window comes back with the same project tabs. */
export class ProjectStore {
  private readonly file: string;
  private projects: Project[] = [];

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "projects.json");
    this.load();
  }

  list(): Project[] {
    return this.projects;
  }

  get(projectId: string): Project | undefined {
    return this.projects.find((project) => project.id === projectId);
  }

  /** Adds the folder, or returns the existing project when it is already open. */
  add(directory: string): Project {
    const normalized = path.resolve(directory);
    const existing = this.projects.find((project) => project.path === normalized);
    if (existing) {
      return existing;
    }
    const project: Project = {
      id: randomUUID(),
      path: normalized,
      name: path.basename(normalized),
      mainPath: readMainWorktree(normalized)
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  remove(projectId: string): void {
    this.projects = this.projects.filter((project) => project.id !== projectId);
    this.save();
  }

  /** Unknown ids are dropped, missing ones kept at the end: the renderer's list may lag behind. */
  reorder(projectIds: string[]): void {
    const known = new Map(this.projects.map((project) => [project.id, project]));
    const ordered = projectIds
      .map((projectId) => known.get(projectId))
      .filter((project): project is Project => project !== undefined);
    const seen = new Set(ordered.map((project) => project.id));
    this.projects = [...ordered, ...this.projects.filter((project) => !seen.has(project.id))];
    this.save();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.projects = parsed.filter(
          (entry): entry is Project =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as Project).id === "string" &&
            typeof (entry as Project).path === "string" &&
            typeof (entry as Project).name === "string"
        );
        // Read again rather than trusted: a folder may have become or stopped being a worktree.
        this.projects = this.projects.map((project) => ({ ...project, mainPath: readMainWorktree(project.path) }));
      }
    } catch {
      // No file yet, or unreadable.
      this.projects = [];
    }
  }

  private save(): void {
    try {
      // Renamed into place: `load` reads a half-written file as none, and the next save would keep that.
      writeFileAtomic.sync(this.file, JSON.stringify(this.projects, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist projects:", error);
    }
  }
}
