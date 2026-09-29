import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, failure } from "../shared/errors";
import { removeAllSessions } from "./agents";
import { worktreeBase, WORKTREES_NEED_GIT, worktreesSupported } from "../shared/types/git";
import { projectRef, projectRefsOf, worktreeOf } from "../shared/types/project";
import type { NoticeSeverity } from "../shared/types/app";
import type { GitActionResult, RepositoryState } from "../shared/types/git";
import type { AddRepositoryResult, ProjectRef, ProjectsChange, ProjectWorktree } from "../shared/types/project";
import type { ControlRecords } from "./control/control-records";
import { git } from "./git/git-client";
import { readHeadBranch, readMainWorktree } from "./util/linked-git-dir";
import type { RepositoryManager } from "./git/repository";
import { inTurn } from "./util/async";
import { logFailure } from "./util/json-file";
import { onDisk } from "./util/path-inside";
import { newWorktreeKey, projectDir, worktreeDir, worktreeFolders, worktreeKeyOf } from "./store/project-dirs";
import { removeRefSandboxes } from "./sbx/sbx";
import { releaseDropped } from "./sbx/sbx-mounts";
import type { SbxLocalStore } from "./sbx/sbx-local";
import type { ProjectStore } from "./store/project-store";
import type { SessionManagerRegistry } from "./terminals/session-registry";
import { tetJsonProblem } from "./store/tet-json";
import { logError } from "./util/error-log";

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
const changes = new Map<string, Promise<unknown>>();
/** The one key under `changes`: every change waits on every other. */
const CHANGE = "projects";

/**
 * Opens a repository as a project, shared by the add-repository dialog (`projects:open`, clone,
 * create) and the control channel, and tells the window (`projectsChanged`), as every change to the
 * list here does: the window keeps no list of its own, so both transports lead to one behaviour.
 * A worktree's folder opens its repository's project, and — one TET made — shows that worktree.
 */
export function addProject(deps: ProjectDeps, directory: string): Promise<AddRepositoryResult> {
  return inTurn(changes, CHANGE, () => addNow(deps, directory));
}

async function addNow(deps: ProjectDeps, directory: string): Promise<AddRepositoryResult> {
  const { store, dataRoot } = deps;
  if (!(await fs.promises.stat(directory).then((stat) => stat.isDirectory(), () => false))) {
    return { error: `${directory} is not a folder` };
  }
  // Only the folder itself counts: one inside a repository is no repository of its own.
  let root: string | undefined;
  try {
    root = await git.resolveRoot(directory);
  } catch (error) {
    return { error: errorMessage(error) };
  }
  if (root === undefined) {
    return { error: `${directory} is not a git repository`, notRepository: true };
  }
  const rootOnDisk = onDisk(root);
  if (rootOnDisk !== onDisk(directory)) {
    return { error: `${directory} lies inside the repository ${rootOnDisk}: add that folder instead` };
  }
  const mainPath = readMainWorktree(root) ?? rootOnDisk;
  let project = store.list().find((entry) => entry.path === mainPath);
  const added: ProjectRef[] = [];
  if (!project) {
    // A project opens only with a tet.json it can use (openStoredProjects).
    const problem = await tetJsonProblem(mainPath);
    if (problem !== undefined) {
      return { error: `${path.basename(mainPath)} was not added: ${problem}` };
    }
    // One held at the start comes back as it was, worktrees and sessions alike.
    project = store.release(mainPath);
    if (!project) {
      let stored: string | undefined;
      try {
        stored = await git.readProjectId(mainPath);
      } catch (error) {
        return { error: `${mainPath}'s git config could not be read: ${errorMessage(error)}` };
      }
      const id = await resolveProjectId(deps, mainPath, stored);
      try {
        project = store.add(mainPath, id);
      } catch (error) {
        return { error: `${path.basename(mainPath)} could not be added: ${errorMessage(error)}` };
      }
    }
    added.push(...projectRefsOf(project));
    added.forEach((ref) => deps.openProjectRef(ref));
  }
  const worktree = worktreeKeyOf(dataRoot, project.id, rootOnDisk);
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
  if (stored !== undefined && !deps.store.all().some((project) => project.id === stored && project.path !== mainPath)) {
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
      const id = await resolveProjectId(deps, project.path, answer.id);
      // Not kept, it is read from the repository again at the next start.
      logFailure(`store the id of ${project.name}`, () => deps.store.setId(project.id, id));
    }
  }
}

/**
 * Opens the stored projects, the repository and every worktree of each. One whose tet.json is
 * broken stays closed this run, as adding it would be refused, and is said: nothing of it is used
 * without that file, and nothing of it is lost — added again once the file is fixed, it opens.
 */
export async function openStoredProjects(deps: ProjectDeps): Promise<void> {
  const projects = deps.store.list();
  const problems = await Promise.all(projects.map((project) => tetJsonProblem(project.path)));
  for (const [index, project] of projects.entries()) {
    const problem = problems[index];
    if (problem !== undefined) {
      deps.store.hold(project.id);
      deps.notice("error", `${project.name} was not opened: ${problem}. Fix it, then add the repository again.`);
      continue;
    }
    for (const ref of projectRefsOf(project)) {
      deps.openProjectRef(ref);
    }
  }
}

/** Stops a repository's or worktree's terminals and git; resolves once its sessions and git
 *  commands have ended, so a worktree's folder is removed only then. Its records go once the
 *  sessions have ended: a stopping tab still prints. */
function closeProjectRef({ repositories, sessions, records }: ProjectDeps, ref: ProjectRef): Promise<void> {
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
      .catch((error: unknown) => logError(`could not remove ${folder}`, error));
  }
}

/** A worktree's folders, then `worktrees/` and `sandboxes/` if it was their last: rmdir refuses one
 *  that still holds another's. */
async function dropWorktreeData(dataRoot: string, refs: ProjectRef[], projectId: string, key: string): Promise<void> {
  const folders = worktreeFolders(dataRoot, projectId, key);
  await dropRefData(refs, folders);
  for (const folder of folders) {
    await fs.promises.rmdir(path.dirname(folder)).catch(() => undefined);
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
  return inTurn(changes, CHANGE, async () => {
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
    try {
      deps.store.remove(projectId);
    } catch (error) {
      return { ok: false, error: `${project.name} could not be removed: ${errorMessage(error)}` };
    }
    deps.projectsChanged({ removed: closing });
    await Promise.all(closing.map((ref) => closeProjectRef(deps, ref)));
    deps.sbxLocal.forgetProject(projectId);
    if (there) {
      const unset = await git.unsetProjectId(project.path);
      if (!unset.ok) {
        logError(`could not unset tet.id in ${project.path}: ${unset.error}`);
      }
    }
    await dropRefData(closing, [projectDir(deps.dataRoot, projectId)]);
    if (!there) {
      // Their folders went with TET's; with the repository there, deleteWorktree took them.
      for (const worktree of project.worktrees.filter((entry) => entry.key !== undefined)) {
        void removeAllSessions(worktree.path);
      }
    }
    return { ok: true };
  });
}

/**
 * Creates a worktree of the project's repository with a new branch of its own under
 * `projects/<id>/worktrees/<key>`, and opens it with its project. The branch names it, and
 * starts at the default branch (`worktreeBase`), as most worktree tools start it.
 */
export function addWorktree(deps: ProjectDeps, projectId: string, typed: string): Promise<AddRepositoryResult> {
  return inTurn(changes, CHANGE, async () => {
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
      // Held by other sandboxes: a worktree handed to a merging tab (worktree-agent-merge), or a path in
      // it dropped into one.
      await releaseDropped(worktree.path);
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
    await dropWorktreeData(deps.dataRoot, [], ref.projectId, ref.worktree!);
    // Only once it is gone: a worktree that stays keeps its sessions. Not waited on — each may
    // start its agent's CLI, and nothing here needs them gone.
    void removeAllSessions(worktree.path);
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
 * only the start, addProject and addWorktree do. Not on a failed read, which lists none.
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
  const gone = unlisted.filter((worktree) => !stillThere.includes(worktree));
  const changed = deps.store.setWorktrees(projectId, [...listed, ...stillThere]);
  if (!changed && gone.length === 0) {
    return;
  }
  for (const worktree of gone) {
    const ref = projectRef(projectId, worktree.key);
    void closeProjectRef(deps, ref)
      .then(() => dropWorktreeData(deps.dataRoot, [ref], projectId, worktree.key!))
      .then(() => removeAllSessions(worktree.path));
  }
  deps.projectsChanged({ removed: gone.map((worktree) => projectRef(projectId, worktree.key)) });
}
