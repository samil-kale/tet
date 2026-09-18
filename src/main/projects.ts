import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { AddRepositoryResult, GitActionResult, Project, WorktreeRef } from "../shared/types";
import type { ControlRecords } from "./control/control-records";
import { git } from "./git/git-client";
import { readMainWorktree } from "./git/linked-git-dir";
import type { Repository, RepositoryManager } from "./git/repository";
import { removeProjectSandboxes } from "./sbx";
import type { SessionManagerRegistry } from "./terminals/session-manager";

/** What opening and closing a project takes — the same singletons ipc.ts holds. */
export interface ProjectDeps {
  store: ProjectStore;
  repositories: RepositoryManager;
  sessions: SessionManagerRegistry;
  records: ControlRecords;
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

/** Resolves once the project's sessions have ended — a worktree's folder is removed only then. */
export function removeProject({ store, repositories, sessions, records }: ProjectDeps, projectId: string): Promise<void> {
  // The project leaves the window at once; its sessions still end by themselves
  // (TerminalSession.stop). Its records go once they have: a stopping tab still prints.
  const closed = sessions.close(projectId).finally(() => records.forgetProject(projectId));
  repositories.close(projectId);
  store.remove(projectId);
  return closed;
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
 * A worktree command runs in the main worktree: through its repository's action slot while it is
 * open, which refreshes its branches after; else git directly.
 */
function runInMain(
  { store, repositories }: ProjectDeps,
  mainPath: string,
  command: (repository: Repository) => Promise<GitActionResult>,
  direct: () => Promise<GitActionResult>
): Promise<GitActionResult> {
  const main = store.list().find((project) => project.path === mainPath);
  const repository = main && repositories.get(main.id);
  return repository ? command(repository) : direct();
}

/**
 * Creates a worktree of the project's repository with a new branch of its own, and opens it as a
 * project under its main worktree's row. Worktree and branch share the name: the folder is the
 * branch's. The branch always starts at the main worktree's HEAD, asked from any of its worktrees.
 */
export async function addWorktree(deps: ProjectDeps, projectId: string, branch: string): Promise<AddRepositoryResult> {
  const project = deps.store.get(projectId);
  if (!project) {
    return { error: "Project not found" };
  }
  const mainPath = project.mainPath ?? project.path;
  // `~/.tet/worktrees/<repository>/<branch>`.
  const target = path.join(deps.dataRoot, "worktrees", path.basename(mainPath), worktreeFolderName(branch));
  const name = branch.trim();
  const result = await runInMain(
    deps,
    mainPath,
    (repository) => repository.addWorktree(target, name),
    () => git.worktreeAdd(mainPath, target, name)
  );
  if (!result.ok) {
    return { error: result.error || "Creating the worktree failed" };
  }
  const added = deps.store.add(target);
  deps.openProject(added);
  deps.projectsChanged({ added: added.id });
  return { project: added };
}

/**
 * Runs a git command on the worktree's folder with its project closed, if it is one: an open
 * terminal holds the folder on Windows, and git would move or delete it half. The sessions are
 * waited for. The project then opens at `reopenAt` — the old path after a failure, since its
 * terminals are gone either way; none after a delete. A new project: its sandboxes are named by the
 * old id, which never comes back, so they go too.
 */
async function withWorktreeClosed(
  deps: ProjectDeps,
  worktreePath: string,
  command: () => Promise<GitActionResult>,
  reopenAt: (result: GitActionResult) => string | undefined
): Promise<GitActionResult> {
  const project = deps.store.list().find((entry) => entry.path === worktreePath);
  if (project) {
    await removeProject(deps, project.id);
    void removeProjectSandboxes(project.id);
  }
  const result = await command();
  if (project) {
    const target = reopenAt(result);
    const reopened = target === undefined ? undefined : deps.store.add(target);
    if (reopened) {
      deps.openProject(reopened);
    }
    deps.projectsChanged({ removed: project.id, added: reopened?.id });
  }
  return result;
}

/** The branch a worktree has checked out, off the disk; none while detached or unknown. */
async function worktreeBranch(worktree: WorktreeRef): Promise<string | undefined> {
  const worktrees = await git.readWorktrees(worktree.mainPath).catch(() => []);
  return worktrees.find((entry) => entry.path === worktree.path)?.branch;
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
  const branch = await worktreeBranch(worktree);
  const gone = !fs.existsSync(worktreePath);
  if (!gone && !force && (await git.hasChanges(worktreePath))) {
    return { ok: false, uncommitted: true };
  }
  const result = await withWorktreeClosed(
    deps,
    worktreePath,
    () =>
      runInMain(
        deps,
        mainPath,
        (repository) => (gone ? repository.pruneWorktrees() : repository.removeWorktree(worktreePath, force)),
        () => (gone ? git.worktreePrune(mainPath) : git.worktreeRemove(mainPath, worktreePath, force))
      ),
    (outcome) => (outcome.ok ? undefined : worktreePath)
  );
  if (!result.ok || branch === undefined) {
    return result;
  }
  // Without the main project open, the local branch alone: its upstream is read off that state.
  return runInMain(
    deps,
    mainPath,
    (repository) => repository.deleteBranch(branch, onRemote),
    () => git.deleteBranch(mainPath, branch)
  );
}

/**
 * Renames the worktree's branch and its folder with it (`git worktree move`, beside itself); an open
 * project opens again at the new path. The branch first — a taken name fails before anything is
 * closed — and back again when the folder cannot move.
 */
export async function renameWorktree(deps: ProjectDeps, worktree: WorktreeRef, branch: string): Promise<GitActionResult> {
  const { path: worktreePath, mainPath } = worktree;
  const from = await worktreeBranch(worktree);
  const to = branch.trim();
  const renameBranch = (oldName: string, newName: string): Promise<GitActionResult> =>
    runInMain(
      deps,
      mainPath,
      (repository) => repository.renameBranch(oldName, newName),
      () => git.renameBranch(mainPath, oldName, newName)
    );
  if (from !== undefined) {
    const renamed = await renameBranch(from, to);
    if (!renamed.ok) {
      return renamed;
    }
  }
  const target = path.join(path.dirname(worktreePath), worktreeFolderName(to));
  const moved = await withWorktreeClosed(
    deps,
    worktreePath,
    () =>
      runInMain(
        deps,
        mainPath,
        (repository) => repository.moveWorktree(worktreePath, target),
        () => git.worktreeMove(mainPath, worktreePath, target)
      ),
    (outcome) => (outcome.ok ? target : worktreePath)
  );
  if (!moved.ok && from !== undefined) {
    await renameBranch(to, from);
  }
  return moved;
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
