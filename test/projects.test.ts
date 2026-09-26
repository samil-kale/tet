import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { resolveProjectRef } from "../src/main/resolved-ref";
import type { ControlRecords } from "../src/main/control/control-records";
import { GitLoginStore } from "../src/main/git-logins";
import { RepositoryManager } from "../src/main/git/repository";
import { projectDir, worktreeDir, worktreeFolders } from "../src/main/project-dirs";
import {
  addProject,
  addWorktree,
  deleteWorktree,
  ProjectStore,
  removeProject,
  resolveStoredIds,
  syncWorktrees,
  type ProjectDeps
} from "../src/main/projects";
import { SbxLocalStore } from "../src/main/sbx-local";
import type { SessionManagerRegistry } from "../src/main/terminals/session-manager";
import { readCommands, readSbxConfig, writeCommands } from "../src/main/tet-json";
import type { ProjectRef, ProjectsChange } from "../src/shared/types";
import { eventually, forkGitInProcess, git, initBare, isolateGitConfig } from "./helpers";

/**
 * projects.ts against the real git and real Repositories, the sessions faked: a project's id in its
 * git config, the worktrees TET makes under the project's folder, what closing their terminals may
 * leave behind, what a delete and a project's removal take along. electron's `utilityProcess` runs
 * git.ts in this process, as in repository.test.ts.
 */

isolateGitConfig("tet-projects-noglobal");
forkGitInProcess();

const real = (folder: string): string => fs.realpathSync.native(folder);

/** `git config --local --get tet.id`, or undefined without one. */
function tetId(folder: string): string | undefined {
  const result = spawnSync("git", ["config", "--local", "--get", "tet.id"], { cwd: folder, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** A repository with a remote; `foreign` worktrees made with plain git, each on a published branch. */
function repository(foreign: string[] = []) {
  const bare = initBare("tet-projects-bare-");
  const main = real(fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-main-")));
  git(main, "init", "-q", "--initial-branch=main");
  git(main, "commit", "-q", "--allow-empty", "-m", "base");
  git(main, "remote", "add", "origin", bare);
  git(main, "push", "-q", "-u", "origin", "main");
  const elsewhere = real(fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-elsewhere-")));
  const at = (name: string): string => path.join(elsewhere, name);
  for (const name of foreign) {
    git(main, "worktree", "add", "-q", "--relative-paths", "-b", name, at(name));
    git(at(name), "push", "-q", "-u", "origin", name);
  }
  return { main, bare, at };
}

const managers: RepositoryManager[] = [];
after(() => managers.forEach((manager) => manager.disposeAll()));

/**
 * The deps main.ts hands projects.ts. `onClose` runs as the sessions of the repository or a
 * worktree end — where a quitting agent could still write.
 */
function open(onClose: (ref: ProjectRef) => void = () => undefined) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-data-"));
  const store = new ProjectStore(dataRoot);
  const told: string[] = [];
  const repositories = new RepositoryManager(
    dataRoot,
    () => undefined,
    () => undefined,
    (projectId) => told.push(projectId),
    () => undefined,
    () => undefined,
    new GitLoginStore(dataRoot)
  );
  managers.push(repositories);
  const changes: ProjectsChange[] = [];
  const deps: ProjectDeps = {
    store,
    repositories,
    sessions: {
      close: async (ref: ProjectRef) => onClose(ref),
      open: () => undefined
    } as unknown as SessionManagerRegistry,
    records: { forget: () => undefined } as unknown as ControlRecords,
    sbxLocal: new SbxLocalStore(dataRoot),
    openProjectRef: (ref) => void repositories.open(resolveProjectRef(dataRoot, store, ref)),
    dataRoot,
    projectsChanged: (change) => changes.push(change),
    notice: () => undefined
  };
  /** Adds the repository and waits for its repository's first read. */
  const add = async (folder: string): Promise<string> => {
    const added = await addProject(deps, folder);
    assert.ok(added.project, added.error);
    await repositories.get({ projectId: added.project.id })!.refresh();
    return added.project.id;
  };
  return { deps, store, repositories, changes, told, dataRoot, add };
}

const remoteHas = (bare: string, branch: string): boolean => git(bare, "branch", "--list", branch) !== "";

describe("a project added", () => {
  it("takes its id from the repository's git config, writing one where there is none", async () => {
    const repo = repository();
    const { deps, store, changes, add } = open();
    const id = await add(repo.main);
    assert.equal(tetId(repo.main), id);
    assert.deepEqual(changes, [{ added: [{ projectId: id }], show: { projectId: id } }]);
    // Removed and added again, by this TET or another: the same id as long as the config keeps it.
    store.remove(id);
    assert.equal((await addProject(deps, repo.main)).project?.id, id);
  });

  it("is the same project when added again, and its repository when a subfolder is picked", async () => {
    const repo = repository();
    const { deps, store, add } = open();
    const id = await add(repo.main);
    fs.mkdirSync(path.join(repo.main, "sub"));
    assert.equal((await addProject(deps, path.join(repo.main, "sub"))).project?.id, id);
    assert.equal(store.list().length, 1);
  });

  it("gets a new id where it is a copy of a project open elsewhere", async () => {
    const repo = repository();
    const { add } = open();
    const id = await add(repo.main);
    const copy = path.join(real(fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-copy-"))), "copy");
    fs.cpSync(repo.main, copy, { recursive: true });
    const copied = await add(copy);
    assert.notEqual(copied, id);
    assert.equal(tetId(copy), copied, "written over the copied one");
    assert.equal(tetId(repo.main), id, "the original keeps its own");
  });

  it("takes at start the id its repository holds, and keeps the stored one where git cannot answer", async () => {
    const repo = repository();
    const { store } = open();
    const held = randomUUID();
    git(repo.main, "config", "tet.id", held);
    store.add(repo.main, randomUUID());
    const gone = path.join(os.tmpdir(), `tet-projects-gone-${randomUUID()}`);
    const kept = store.add(gone, randomUUID()).id;
    await resolveStoredIds({ store, notice: () => undefined });
    assert.deepEqual(
      store.list().map((project) => project.id),
      [held, kept]
    );
  });

  it("refuses a folder that is no git repository", async () => {
    const { deps, store } = open();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-plain-"));
    const result = await addProject(deps, plain);
    assert.match(result.error ?? "", /is not a git repository/);
    assert.deepEqual(store.list(), []);
  });

  it("opens a worktree's folder as its project, listing a worktree made elsewhere without a key", async () => {
    const repo = repository(["picked"]);
    const { deps, store, repositories } = open();
    const added = await addProject(deps, repo.at("picked"));
    assert.equal(added.project?.path, repo.main);
    assert.equal(added.worktree, undefined, "one made elsewhere is never opened");
    const id = added.project!.id;
    syncWorktrees(deps, id, await repositories.get({ projectId: id })!.refresh());
    assert.deepEqual(store.get(id)?.worktrees, [{ path: repo.at("picked"), branch: "picked", key: undefined }]);
  });
});

describe("a worktree TET makes", () => {
  it("lies under the project's folder, named by its key, its branch at the default branch with its base", async () => {
    const repo = repository();
    const { deps, store, changes, dataRoot, add } = open();
    const id = await add(repo.main);
    const added = await addWorktree(deps, id, "feature");
    assert.ok(added.worktree, added.error);
    const ref = { projectId: id, worktree: added.worktree };
    const files = worktreeDir(dataRoot, id, added.worktree);
    assert.equal(real(files), files, "in on-disk spelling, as git lists it");
    assert.equal(git(files, "branch", "--show-current"), "feature");
    assert.equal(git(repo.main, "config", "branch.feature.base"), "main");
    assert.deepEqual(store.get(id)?.worktrees, [{ key: added.worktree, path: files, branch: "feature" }]);
    assert.deepEqual(changes.at(-1), { added: [ref], show: ref });
    assert.equal(tetId(files), id, "a worktree reads its project's id");
  });

  it("keeps its folder when renamed: the branch alone changes", async () => {
    const repo = repository();
    const { deps, store, repositories, dataRoot, add } = open();
    const id = await add(repo.main);
    const key = (await addWorktree(deps, id, "before")).worktree!;
    const main = repositories.get({ projectId: id })!;
    assert.deepEqual(await main.renameBranch("before", "after"), { ok: true });
    syncWorktrees(deps, id, main.getState());
    const files = worktreeDir(dataRoot, id, key);
    assert.deepEqual(store.get(id)?.worktrees, [{ key, path: files, branch: "after" }]);
    assert.equal(git(files, "branch", "--show-current"), "after");
  });

  it("is deleted with its folder, TET's data of it, its branch and the upstream it was asked to", async () => {
    const repo = repository();
    const { deps, store, repositories, changes, dataRoot, add } = open();
    const id = await add(repo.main);
    const key = (await addWorktree(deps, id, "target")).worktree!;
    const ref = { projectId: id, worktree: key };
    const files = worktreeDir(dataRoot, id, key);
    git(files, "push", "-q", "-u", "origin", "target");
    // What the watcher reads in the app: the upstream the delete takes along.
    await repositories.get({ projectId: id })!.refresh();
    const result = await deleteWorktree(deps, ref, { force: false, onRemote: true });
    assert.deepEqual(result, { ok: true });
    assert.ok(worktreeFolders(dataRoot, id, key).every((folder) => !fs.existsSync(folder)));
    assert.equal(git(repo.main, "branch", "--list", "target"), "", "the branch went with it");
    assert.ok(!remoteHas(repo.bare, "target"), "and its upstream, as asked");
    assert.deepEqual(store.get(id)?.worktrees, []);
    assert.deepEqual(changes.at(-1), { removed: [ref] });
    // Refreshed by the repository's own action slot, not left for the watcher.
    assert.ok(!repositories.get({ projectId: id })!.getState().worktrees.some((worktree) => worktree.branch === "target"));
  });

  it("is refused up front while another command runs in its repository, and runs once it is done", async () => {
    const repo = repository();
    const closed: ProjectRef[] = [];
    const { deps, repositories, changes, dataRoot, add } = open((ref) => closed.push(ref));
    const id = await add(repo.main);
    const key = (await addWorktree(deps, id, "held")).worktree!;
    const seen = changes.length;
    // As a push running in the repository.
    let release: () => void = () => undefined;
    const other = repositories.get({ projectId: id })!.exclusive(() => new Promise((resolve) => (release = () => resolve({ ok: true }))));
    const ref = { projectId: id, worktree: key };
    const refused = await deleteWorktree(deps, ref, { force: true, onRemote: false });
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? "", /already running/);
    assert.deepEqual(closed, [], "no terminal closed for a command that could not run");
    assert.equal(changes.length, seen);
    assert.ok(fs.existsSync(worktreeDir(dataRoot, id, key)));
    release();
    assert.deepEqual(await other, { ok: true });
    assert.deepEqual(await deleteWorktree(deps, ref, { force: true, onRemote: false }), { ok: true });
  });

  it("is asked about again when written to while its terminals close, not refused by git after", async () => {
    const repo = repository();
    let dataRoot = "";
    let key = "";
    // As an agent saving its work on its way out.
    const opened = open((ref) => {
      if (ref.worktree === key) {
        fs.writeFileSync(path.join(worktreeDir(dataRoot, ref.projectId, key), "late.txt"), "late\n");
      }
    });
    dataRoot = opened.dataRoot;
    const id = await opened.add(repo.main);
    key = (await addWorktree(opened.deps, id, "busy")).worktree!;
    const ref = { projectId: id, worktree: key };
    const result = await deleteWorktree(opened.deps, ref, { force: false, onRemote: false });
    assert.deepEqual(result, { ok: false, needsConfirmation: "uncommitted" });
    assert.ok(fs.existsSync(path.join(worktreeDir(dataRoot, id, key), "late.txt")), "nothing deleted without the question");
    assert.deepEqual(await deleteWorktree(opened.deps, ref, { force: true, onRemote: false }), { ok: true });
  });

  it("is only one TET made: another is not found", async () => {
    const repo = repository(["elsewhere"]);
    const { deps, add } = open();
    const id = await add(repo.main);
    const result = await deleteWorktree(deps, { projectId: id, worktree: "nope" }, { force: true, onRemote: false });
    assert.deepEqual(result, { ok: false, error: "Worktree not found" });
    assert.ok(fs.existsSync(repo.at("elsewhere")));
  });
});

describe("a project removed", () => {
  it("takes its worktrees with their branches, TET's folder of it and its id; the rest stays", async () => {
    const repo = repository(["foreign"]);
    const { deps, store, changes, dataRoot, add } = open();
    const id = await add(repo.main);
    const key = (await addWorktree(deps, id, "own")).worktree!;
    deps.sbxLocal.restore(id, { secrets: { TOKEN: "encrypted" }, variables: {} });
    assert.deepEqual(await removeProject(deps, id), { ok: true });
    assert.ok(!fs.existsSync(worktreeDir(dataRoot, id, key)));
    assert.equal(git(repo.main, "branch", "--list", "own"), "", "its branch went with it");
    assert.ok(!fs.existsSync(projectDir(dataRoot, id)));
    assert.equal(tetId(repo.main), undefined);
    assert.deepEqual(deps.sbxLocal.encrypted(id), { secrets: {}, variables: {} });
    assert.deepEqual(store.list(), []);
    assert.deepEqual(changes.slice(-2), [{ removed: [{ projectId: id, worktree: key }] }, { removed: [{ projectId: id }] }]);
    assert.ok(fs.existsSync(repo.main), "the repository's folder stays");
    assert.ok(fs.existsSync(repo.at("foreign")), "and a worktree made elsewhere");
    assert.equal(git(repo.main, "branch", "--list", "--format=%(refname:short)", "foreign"), "foreign");
  });

  it("stops, the project left open, where a worktree cannot go", async () => {
    const repo = repository();
    const { deps, store, repositories, add } = open();
    const id = await add(repo.main);
    await addWorktree(deps, id, "kept");
    let release: () => void = () => undefined;
    const other = repositories.get({ projectId: id })!.exclusive(() => new Promise((resolve) => (release = () => resolve({ ok: true }))));
    const result = await removeProject(deps, id);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /already running/);
    assert.ok(store.get(id));
    assert.equal(tetId(repo.main), id);
    release();
    await other;
  });
});

describe("a worktree's tet.json", () => {
  it("is its project's, read without the ports and never written from the worktree", async () => {
    const repo = repository(["inherits"]);
    const worktree = repo.at("inherits");
    const ports = [{ host: "3000", container: "3000" }];
    fs.writeFileSync(
      path.join(repo.main, "tet.json"),
      JSON.stringify({ commands: ["npm test"], sbx: { enabled: true, hosts: ["example.com"], ports } })
    );
    fs.writeFileSync(path.join(worktree, "tet.json"), JSON.stringify({ commands: ["its own copy"] }));
    assert.deepEqual(await readCommands(worktree), [{ command: "npm test" }]);
    const config = await readSbxConfig(worktree);
    assert.equal(config.enabled, true);
    assert.deepEqual(config.hosts, ["example.com"]);
    assert.deepEqual(config.ports, [], "a port reaches the repository's sandbox alone");
    assert.deepEqual((await readSbxConfig(repo.main)).ports, ports);
    await assert.rejects(writeCommands(worktree, []), /takes its settings from/);
    assert.deepEqual(await readCommands(repo.main), [{ command: "npm test" }], "left as it was");
  });

  it("tells the project once when the repository's changes, and not for a worktree's own", async () => {
    const repo = repository();
    const { deps, told, dataRoot, repositories, add } = open();
    const id = await add(repo.main);
    const key = (await addWorktree(deps, id, "told")).worktree!;
    await repositories.get({ projectId: id, worktree: key })!.refresh();
    fs.writeFileSync(path.join(worktreeDir(dataRoot, id, key), "tet.json"), JSON.stringify({ commands: ["ignored"] }));
    fs.writeFileSync(path.join(repo.main, "tet.json"), JSON.stringify({ commands: ["npm test"] }));
    await eventually("told", () => told.includes(id));
    assert.ok(told.every((projectId) => projectId === id));
  });
});
