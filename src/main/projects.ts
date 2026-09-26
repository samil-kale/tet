import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, failure } from "../shared/errors";
import { projectRef, projectRefsOf, worktreeBase, worktreeOf, worktreesSupported, WORKTREES_NEED_GIT } from "../shared/types";
import type {
  AddRepositoryResult,
  ProjectRef,
  GitActionResult,
  NoticeSeverity,
  Project,
  ProjectsChange,
  ProjectWorktree,
  RepositoryState
} from "../shared/types";
import type { ControlRecords } from "./control/control-records";
import { git } from "./git/git-client";
import { readHeadBranch, readMainWorktree } from "./git/linked-git-dir";
import type { RepositoryManager } from "./git/repository";
import { isRecord, readJson, saveJson } from "./json-file";
import { onDisk } from "./path-inside";
import { newWorktreeKey, ownedWorktreeKeys, projectDir, worktreeDir, worktreeFolders, worktreeKeyOf } from "./project-dirs";
import { removeRefSandboxes } from "./sbx";
import type { SbxLocalStore } from "./sbx-local";
import type { SessionManagerRegistry } from "./terminals/session-manager";

/** What opening and closing projects and their worktrees takes — the same singletons ipc/ holds. */
export interface ProjectDeps {
  store: ProjectStore;
  repositories: RepositoryManager;
  sessions: SessionManagerRegistry;
  records: ControlRecords;
  sbxLocal: SbxLocalStore;
  /** Starts the git and terminals of the repository or a worktree; its project is the store's. */
  openProjectRef: (ref: ProjectRef) => void;
  /** TET's data folder (data-root.ts), holding each project's (project-dirs.ts). */
  dataRoot: string;
  /** Tells the window, as the control channel does. */
  projectsChanged: (change: ProjectsChange) => void;
  /** What went wrong with nobody asking — a project id that could not be kept. */
  notice: (severity: NoticeSeverity, message: string) => void;
}

/**
 * One change to the projects at a time — an add, a removal, a new worktree: two adds of one folder
 * would each mint an id, and an add meeting a removal of the same folder would have its id unset and
 * its folder deleted underneath it.
 */
let queue: Promise<unknown> = Promise.resolve();

function inTurn<T>(change: () => Promise<T>): Promise<T> {
  const turn = queue.then(change);
  queue = turn.catch(() => undefined);
  return turn;
}

/**
 * Opens a repository as a project, shared by the add-repository dialog (`projects:open`, clone,
 * create) and the control channel, and tells the window (`projectsChanged`), as every change to the
 * list here does: the window keeps no list of its own, so both transports lead to one behaviour.
 * A worktree's folder opens its repository's project, and — one TET made — shows that worktree.
 */
export function addProject(deps: ProjectDeps, directory: string): Promise<AddRepositoryResult> {
  return inTurn(() => addNow(deps, directory));
}

async function addNow(deps: ProjectDeps, directory: string): Promise<AddRepositoryResult> {
  const { store, dataRoot } = deps;
  if (!(await fs.promises.stat(directory).then((stat) => stat.isDirectory(), () => false))) {
    return { error: `${directory} is not a folder` };
  }
  // Picking a subdirectory opens the repository itself: git reports paths relative to the root.
  const root = await git.resolveRoot(directory).catch(() => undefined);
  if (root === undefined) {
    return { error: `${directory} is not a git repository` };
  }
  const mainPath = readMainWorktree(root) ?? onDisk(root);
  let project = store.list().find((entry) => entry.path === mainPath);
  const added: ProjectRef[] = [];
  if (!project) {
    let stored: string | undefined;
    try {
      stored = await git.readProjectId(mainPath);
    } catch (error) {
      return { error: `${mainPath}'s git config could not be read: ${errorMessage(error)}` };
    }
    project = store.add(mainPath, await resolveProjectId(deps, mainPath, stored));
    added.push(...projectRefsOf(project));
    added.forEach((ref) => deps.openProjectRef(ref));
  }
  const worktree = worktreeKeyOf(dataRoot, project.id, onDisk(root));
  deps.projectsChanged({ added, show: projectRef(project.id, worktree) });
  return { project, worktree };
}

/**
 * The project id from the repository's `tet.id` as read (`stored`), written where it has none. A
 * value another project holds at another path — a copied folder — is replaced: two folders never
 * share a project's data. One git will not take is used for this run alone, and said: what TET
 * keeps of the project is lost with it.
 */
async function resolveProjectId(
  deps: Pick<ProjectDeps, "store" | "notice">,
  mainPath: string,
  stored: string | undefined
): Promise<string> {
  if (stored !== undefined && !deps.store.list().some((project) => project.id === stored && project.path !== mainPath)) {
    return stored;
  }
  const id = randomUUID();
  const written = await git.writeProjectId(mainPath, id).catch(failure);
  if (!written.ok) {
    deps.notice(
      "warning",
      `TET could not write its project id into ${mainPath}'s git config, so what it keeps of the project is gone after a restart: ${written.error}`
    );
  }
  return id;
}

/**
 * Each stored project's id as its repository says, before anything of it opens: read at once, then
 * settled in order, so a copied folder is told apart from the one it was copied from. A repository
 * git cannot answer for keeps the stored id — no answer is not "none", which would replace it.
 */
export async function resolveStoredIds(deps: Pick<ProjectDeps, "store" | "notice">): Promise<void> {
  const projects = deps.store.list();
  const read = await Promise.all(
    projects.map((project) =>
      git.readProjectId(project.path).then(
        (id) => ({ id }),
        () => undefined
      )
    )
  );
  for (const [index, project] of projects.entries()) {
    const answer = read[index];
    if (answer !== undefined) {
      deps.store.setId(project.id, await resolveProjectId(deps, project.path, answer.id));
    }
  }
}

/** Stops a repository's or worktree's terminals and git; resolves once its sessions and git
 *  commands have ended, so a worktree's folder is removed only then. Its records go once the
 *  sessions have ended: a stopping tab still prints. */
export function closeProjectRef({ repositories, sessions, records }: ProjectDeps, ref: ProjectRef): Promise<void> {
  const sessionsEnded = sessions.close(ref).finally(() => records.forget(ref));
  return Promise.all([sessionsEnded, repositories.close(ref)]).then(() => undefined);
}

/** The sandboxes of closed repositories and worktrees and a folder of TET's data; what cannot go is
 *  logged, not thrown: the repositories and worktrees are gone either way. */
async function dropRefData(refs: ProjectRef[], folders: string[]): Promise<void> {
  await removeRefSandboxes(refs);
  for (const folder of folders) {
    await fs.promises
      .rm(folder, { recursive: true, force: true, maxRetries: 5 })
      .catch((error: unknown) => console.error(`[tet] could not remove ${folder}:`, error));
  }
}

/**
 * Removes the project: the worktrees TET made are deleted with their branches, one after another
 * through the repository's Repository, and the first that fails stops it with the project left
 * open. Then its sandboxes, its sbx values, its `tet.id` and TET's folder of it; the repository's
 * own folder stays, and so do worktrees made elsewhere. A repository whose folder is gone has no git
 * to ask: its worktrees are only closed, their folders going with TET's.
 */
export function removeProject(deps: ProjectDeps, projectId: string): Promise<GitActionResult> {
  return inTurn(async () => {
    const project = deps.store.get(projectId);
    if (!project) {
      return { ok: false, error: "Project not found" };
    }
    const there = fs.existsSync(project.path);
    const [main, ...worktrees] = projectRefsOf(project);
    for (const ref of worktrees) {
      const deleted = there ? await deleteWorktree(deps, ref, { force: true, onRemote: false }) : undefined;
      if (deleted && !deleted.ok) {
        return deleted;
      }
    }
    const closing = there ? [main] : [main, ...worktrees];
    deps.store.remove(projectId);
    deps.projectsChanged({ removed: closing });
    await Promise.all(closing.map((ref) => closeProjectRef(deps, ref)));
    deps.sbxLocal.forgetProject(projectId);
    if (there) {
      const unset = await git.unsetProjectId(project.path);
      if (!unset.ok) {
        console.error(`[tet] could not unset tet.id in ${project.path}: ${unset.error}`);
      }
    }
    await dropRefData(closing, [projectDir(deps.dataRoot, projectId)]);
    return { ok: true };
  });
}

/**
 * Creates a worktree of the project's repository with a new branch of its own under
 * `projects/<id>/worktrees/<key>`, and opens it with its project. The branch names it, and
 * starts at the default branch (`worktreeBase`), as most worktree tools start it.
 */
export function addWorktree(deps: ProjectDeps, projectId: string, typed: string): Promise<AddRepositoryResult> {
  return inTurn(async () => {
    const branch = typed.trim();
    const repository = deps.repositories.get(projectRef(projectId));
    if (!deps.store.get(projectId) || !repository) {
      return { error: "Project not found" };
    }
    const base = worktreeBase(repository.getState());
    if (!base) {
      return { error: "There is no branch to start a worktree at" };
    }
    // Asked here too, not only in the menus: `tet-ctl worktree-add` has none.
    if (!worktreesSupported(await git.version())) {
      return { error: `Creating a worktree ${WORKTREES_NEED_GIT}` };
    }
    const key = newWorktreeKey(deps.dataRoot, projectId);
    const ref = projectRef(projectId, key);
    const target = worktreeDir(deps.dataRoot, projectId, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = await repository.addWorktree(target, branch, base);
    if (!result.ok) {
      fs.rmSync(target, { recursive: true, force: true });
      return { error: result.error || "Creating the worktree failed" };
    }
    // As the store has them now: the add's own refresh may have listed it already (syncWorktrees).
    const others = deps.store.get(projectId)?.worktrees.filter((worktree) => worktree.key !== key) ?? [];
    deps.store.setWorktrees(projectId, [...others, { key, path: target, branch }]);
    deps.openProjectRef(ref);
    deps.projectsChanged({ added: [ref], show: ref });
    return { project: deps.store.get(projectId), worktree: key };
  });
}

/**
 * Deletes a worktree TET made and its branch, which tet couples: its changes are asked about first —
 * answered as `uncommitted` before anything is closed — and forced once confirmed; a folder already
 * gone is pruned. The branch goes after the worktree (git refuses one checked out), and with
 * `onRemote` its upstream too, as a branch's own delete does. On failure the worktree opens again;
 * its sandboxes, removed with its terminals, are made anew at its next tab.
 */
export async function deleteWorktree(
  deps: ProjectDeps,
  ref: ProjectRef,
  { force, onRemote }: { force: boolean; onRemote: boolean }
): Promise<GitActionResult> {
  const project = deps.store.get(ref.projectId);
  const worktree = project && worktreeOf(project, ref);
  const repository = deps.repositories.get(projectRef(ref.projectId));
  if (!worktree || !repository) {
    return { ok: false, error: "Worktree not found" };
  }
  const gone = !fs.existsSync(worktree.path);
  // As git has it now: renamed in a shell, the store's name may lag behind.
  const branch = readHeadBranch(worktree.path) ?? worktree.branch;
  const uncommitted = async (): Promise<boolean> => !gone && !force && (await git.hasChanges(worktree.path));
  if (await uncommitted()) {
    return { ok: false, needsConfirmation: "uncommitted" };
  }
  // One hold of the repository: a command running elsewhere refuses this before the worktree closes.
  return repository.exclusive(async () => {
    // A throw (the git process gone, a session refusing to close) is a failure like git's own:
    // the worktree must open again rather than linger half-closed.
    let result: GitActionResult;
    try {
      // An open terminal holds the folder on Windows, and git would delete it half.
      await closeProjectRef(deps, ref);
      await removeRefSandboxes([ref]);
      // Asked again with its terminals gone: one may have written meanwhile, and git would refuse
      // without the question being put.
      result = (await uncommitted())
        ? { ok: false, needsConfirmation: "uncommitted" }
        : gone
          ? await repository.pruneWorktrees()
          : await repository.removeWorktree(worktree.path, force);
    } catch (error) {
      result = failure(error);
    }
    if (!result.ok) {
      deps.openProjectRef(ref);
      return result;
    }
    await dropRefData([], worktreeFolders(deps.dataRoot, ref.projectId, ref.worktree!));
    const left = deps.store.get(ref.projectId)?.worktrees.filter((entry) => entry.key !== ref.worktree) ?? [];
    deps.store.setWorktrees(ref.projectId, left);
    deps.projectsChanged({ removed: [ref] });
    return branch === undefined ? result : repository.deleteBranch(branch, onRemote);
  });
}

/**
 * The project's worktrees as git lists them in any of its repositories' and worktrees' state, every
 * branch name as it now is. One TET made that git no longer lists and whose folder is gone was
 * deleted outside TET: it closes, and its data and sandboxes go. One still on disk stays whatever a
 * read says — another repository's or worktree's refresh may predate its add. It never opens one:
 * only the start and addWorktree do. Not on a failed read, which lists none.
 */
export function syncWorktrees(deps: ProjectDeps, projectId: string, state: RepositoryState): void {
  const project = deps.store.get(projectId);
  if (!project || state.error !== undefined) {
    return;
  }
  const listed: ProjectWorktree[] = state.worktrees
    .filter((worktree) => !worktree.main)
    .map(({ path: worktreePath, branch, key }) => ({ path: worktreePath, branch, key }));
  const unlisted = project.worktrees.filter(
    (worktree) => worktree.key !== undefined && !listed.some((entry) => entry.key === worktree.key)
  );
  const stillThere = unlisted.filter((worktree) => fs.existsSync(path.join(worktree.path, ".git")));
  const gone = unlisted
    .filter((worktree) => !stillThere.includes(worktree))
    .map((worktree) => projectRef(projectId, worktree.key));
  const changed = deps.store.setWorktrees(projectId, [...listed, ...stillThere]);
  if (!changed && gone.length === 0) {
    return;
  }
  for (const ref of gone) {
    void closeProjectRef(deps, ref).then(() => dropRefData([ref], worktreeFolders(deps.dataRoot, projectId, ref.worktree!)));
  }
  deps.projectsChanged({ removed: gone });
}

/** Finding a project, all either transport needs to answer *about* one; the store's own edits
 *  are the window's (`ipc/projects.ts`). Taken by `ControlDeps`. */
export interface ProjectLookup {
  list(): Project[];
  get(projectId: string): Project | undefined;
}

/** The open repositories, persisted so the window comes back with the same projects. */
export class ProjectStore implements ProjectLookup {
  private readonly file: string;
  private projects: Project[] = [];

  constructor(private readonly dataRoot: string) {
    this.file = path.join(dataRoot, "projects.json");
    this.load();
  }

  list(): Project[] {
    return this.projects;
  }

  get(projectId: string): Project | undefined {
    return this.projects.find((project) => project.id === projectId);
  }

  /** Adds the repository at `mainPath` (in on-disk spelling) under `id`, with the worktrees TET
   *  made for it. */
  add(mainPath: string, id: string): Project {
    const project: Project = { id, path: mainPath, name: path.basename(mainPath), worktrees: this.ownWorktrees(id) };
    this.projects.push(project);
    this.save();
    return project;
  }

  /** The project's id as its repository now says (resolveStoredIds); its worktrees read for that id. */
  setId(projectId: string, id: string): void {
    const project = this.get(projectId);
    if (!project || project.id === id) {
      return;
    }
    this.projects = this.projects.map((entry) => (entry === project ? { ...project, id, worktrees: this.ownWorktrees(id) } : entry));
    this.save();
  }

  /** Replaces the project's worktrees; whether anything changed. Never stored. */
  setWorktrees(projectId: string, worktrees: ProjectWorktree[]): boolean {
    const project = this.get(projectId);
    if (!project || JSON.stringify(project.worktrees) === JSON.stringify(worktrees)) {
      return false;
    }
    this.projects = this.projects.map((entry) => (entry === project ? { ...project, worktrees } : entry));
    return true;
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

  /** The worktrees TET made for the project, off the disk without git: the first frame has their
   *  rows, and the first state corrects them (syncWorktrees). */
  private ownWorktrees(projectId: string): ProjectWorktree[] {
    return ownedWorktreeKeys(this.dataRoot, projectId).map((key) => {
      const folder = worktreeDir(this.dataRoot, projectId, key);
      return { key, path: folder, branch: readHeadBranch(folder) };
    });
  }

  private load(): void {
    const parsed = readJson(this.file);
    if (!Array.isArray(parsed)) {
      return;
    }
    this.projects = parsed
      .filter(
        (entry) =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          typeof entry.path === "string" &&
          typeof entry.name === "string" &&
          // A worktree was stored as a project of its own before, with `mainPath` or, older, without.
          entry.mainPath === undefined &&
          readMainWorktree(entry.path) === undefined
      )
      .map((entry) => {
        const { id, path: mainPath, name } = entry as { id: string; path: string; name: string };
        return { id, path: mainPath, name, worktrees: this.ownWorktrees(id) };
      });
  }

  private save(): void {
    // Renamed into place: `load` reads a half-written file as none, and the next save would keep that.
    saveJson(
      this.file,
      this.projects.map(({ id, path: mainPath, name }) => ({ id, path: mainPath, name })),
      "projects"
    );
  }
}
