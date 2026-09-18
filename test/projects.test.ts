import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ControlRecords } from "../src/main/control/control-records";
import { RepositoryManager } from "../src/main/git/repository";
import { addWorktree, deleteWorktree, ProjectStore, renameWorktree, type ProjectDeps } from "../src/main/projects";
import { SbxSecretStore } from "../src/main/sbx-secrets";
import type { SessionManagerRegistry } from "../src/main/terminals/session-manager";
import type { Project } from "../src/shared/types";
import { eventually, forkGitInProcess, git, isolateGitConfig } from "./helpers";

/**
 * projects.ts's worktree actions against the real git and real Repositories, the project's
 * sessions faked: which repository a command runs through, what closing the terminals may leave
 * behind, what a delete takes along. electron's `utilityProcess` runs git.ts in this process, as in
 * repository.test.ts.
 */

isolateGitConfig("tet-projects-noglobal");
forkGitInProcess();

const real = (folder: string): string => fs.realpathSync.native(folder);

/**
 * A repository with a remote, and its linked worktrees `names`, each on a branch of that name
 * published with an upstream. `worktree` is the shape deleteWorktree and renameWorktree take.
 */
function repositoryWithWorktrees(names: string[]) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-bare-"));
  git(bare, "init", "-q", "--bare", "--initial-branch=main");
  const main = real(fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-main-")));
  git(main, "init", "-q", "--initial-branch=main");
  git(main, "commit", "-q", "--allow-empty", "-m", "base");
  git(main, "remote", "add", "origin", bare);
  git(main, "push", "-q", "-u", "origin", "main");
  const worktrees = real(fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-wts-")));
  const at = (name: string): string => path.join(worktrees, name);
  for (const name of names) {
    git(main, "worktree", "add", "-q", "--relative-paths", "-b", name, at(name));
    git(at(name), "push", "-q", "-u", "origin", name);
  }
  return { main, bare, at, worktree: (name: string) => ({ path: at(name), mainPath: main }) };
}

const managers: RepositoryManager[] = [];
after(() => managers.forEach((manager) => manager.disposeAll()));

/**
 * The deps main.ts hands projects.ts, with the given folders open as projects. `onClose` runs as a
 * project's sessions end — where a quitting agent could still write.
 */
async function open(folders: string[], onClose: (project: Project) => void = () => undefined) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-data-"));
  const store = new ProjectStore(dataRoot);
  const repositories = new RepositoryManager(
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined
  );
  managers.push(repositories);
  const changes: { added?: string; removed?: string }[] = [];
  const deps: ProjectDeps = {
    store,
    repositories,
    sessions: {
      close: async (projectId: string) => {
        const project = store.list().find((entry) => entry.id === projectId);
        if (project) {
          onClose(project);
        }
      },
      open: () => undefined
    } as unknown as SessionManagerRegistry,
    records: { forgetProject: () => undefined } as unknown as ControlRecords,
    sbxSecrets: new SbxSecretStore(dataRoot),
    openProject: (project) => void repositories.open(project),
    dataRoot,
    projectsChanged: (change) => changes.push(change)
  };
  for (const folder of folders) {
    // open() starts it; refresh() is what can be awaited.
    await repositories.open(store.add(folder)).refresh();
  }
  const idOf = (folder: string): string => store.list().find((project) => project.path === folder)!.id;
  return { deps, store, repositories, changes, idOf };
}

const remoteHas = (bare: string, branch: string): boolean => git(bare, "branch", "--list", branch) !== "";

describe("a worktree deleted with its main project closed", () => {
  let repo: ReturnType<typeof repositoryWithWorktrees>;

  before(() => {
    repo = repositoryWithWorktrees(["target", "sibling", "alone"]);
  });

  it("runs through a sibling worktree's repository, and deletes the upstream it was asked to", async () => {
    const { deps, repositories, idOf } = await open([repo.at("target"), repo.at("sibling")]);
    const sibling = repositories.get(idOf(repo.at("sibling")))!;
    const result = await deleteWorktree(deps, repo.worktree("target"), { force: false, onRemote: true });
    assert.deepEqual(result, { ok: true });
    // Refreshed by its own action slot, not left for the watcher.
    assert.ok(!sibling.getState().worktrees.some((worktree) => worktree.branch === "target"), "run through the sibling");
    assert.ok(!fs.existsSync(repo.at("target")));
    assert.equal(git(repo.main, "branch", "--list", "target"), "", "the branch went with it");
    assert.ok(!remoteHas(repo.bare, "target"), "and its upstream, as asked");
  });

  it("is refused, before anything closes, with no project of the repository left to run it", async () => {
    const { deps, store, changes } = await open([repo.at("alone")]);
    const result = await deleteWorktree(deps, repo.worktree("alone"), { force: false, onRemote: true });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /^Open .+ to delete this worktree$/);
    assert.ok(fs.existsSync(repo.at("alone")));
    assert.ok(remoteHas(repo.bare, "alone"));
    assert.equal(store.list().length, 1, "its project still open");
    assert.deepEqual(changes, []);
  });
});

describe("worktrees of two repositories with one folder name", () => {
  it("are kept apart under ~/.tet/worktrees", async () => {
    const repositoryNamedApp = (): string => {
      const folder = path.join(real(fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-same-"))), "app");
      fs.mkdirSync(folder);
      git(folder, "init", "-q", "--initial-branch=main");
      git(folder, "commit", "-q", "--allow-empty", "-m", "base");
      return folder;
    };
    const first = repositoryNamedApp();
    const second = repositoryNamedApp();
    const { deps, repositories, idOf } = await open([first, second]);
    // The first read, which knows the branch a worktree starts at.
    await eventually("both repositories read", () =>
      [first, second].every((folder) => repositories.get(idOf(folder))?.getState().defaultBranch !== undefined)
    );
    const added = [await addWorktree(deps, idOf(first), "feature"), await addWorktree(deps, idOf(second), "feature")];
    assert.deepEqual(added.map((result) => result.error), [undefined, undefined]);
    const [a, b] = added.map((result) => result.project!.path);
    assert.notEqual(path.dirname(a), path.dirname(b));
    assert.deepEqual([path.basename(a), path.basename(b)], ["feature", "feature"], "each named by its branch");
  });
});

describe("a worktree command while another runs in its repository", () => {
  it("is refused up front, its project still open, and runs once the other is done", async () => {
    const repo = repositoryWithWorktrees(["held"]);
    const closed: string[] = [];
    const { deps, repositories, changes, idOf } = await open([repo.main, repo.at("held")], (project) => closed.push(project.path));
    const main = repositories.get(idOf(repo.main))!;
    // As a push running in the main project.
    let release: () => void = () => undefined;
    const other = main.exclusive(() => new Promise((resolve) => (release = () => resolve({ ok: true }))));
    const worktree = repo.worktree("held");
    for (const result of [
      await deleteWorktree(deps, worktree, { force: true, onRemote: false }),
      await renameWorktree(deps, worktree, "renamed")
    ]) {
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /already running/);
    }
    assert.deepEqual(closed, [], "no terminal closed for a command that could not run");
    assert.deepEqual(changes, []);
    assert.ok(fs.existsSync(repo.at("held")));
    assert.equal(git(repo.at("held"), "branch", "--show-current"), "held", "the branch not renamed either");
    release();
    assert.deepEqual(await other, { ok: true });
    assert.deepEqual(await deleteWorktree(deps, worktree, { force: true, onRemote: false }), { ok: true });
    assert.ok(!fs.existsSync(repo.at("held")));
  });
});

describe("a worktree written to while its terminals close", () => {
  it("is asked about again, not refused by git after the terminals are gone", async () => {
    const repo = repositoryWithWorktrees(["busy"]);
    // As an agent saving its work on its way out.
    const { deps } = await open([repo.main, repo.at("busy")], (project) => {
      if (project.path === repo.at("busy")) {
        fs.writeFileSync(path.join(repo.at("busy"), "late.txt"), "late\n");
      }
    });
    const result = await deleteWorktree(deps, repo.worktree("busy"), { force: false, onRemote: false });
    assert.deepEqual(result, { ok: false, uncommitted: true });
    assert.ok(fs.existsSync(path.join(repo.at("busy"), "late.txt")), "nothing deleted without the question");
    assert.deepEqual(await deleteWorktree(deps, repo.worktree("busy"), { force: true, onRemote: false }), { ok: true });
    assert.ok(!fs.existsSync(repo.at("busy")));
  });
});

describe("a worktree renamed to the folder it already has", () => {
  it("renames only the branch where the folder name stays, closing nothing", async () => {
    const repo = repositoryWithWorktrees([]);
    git(repo.main, "worktree", "add", "-q", "--relative-paths", "-b", "feature/x", repo.at("feature-x"));
    const { deps, changes } = await open([repo.main, repo.at("feature-x")]);
    assert.deepEqual(await renameWorktree(deps, repo.worktree("feature-x"), "feature-x"), { ok: true });
    assert.equal(git(repo.at("feature-x"), "branch", "--show-current"), "feature-x");
    assert.deepEqual(changes, [], "its project stays open");
  });

  it("moves the folder by case alone, where git refuses that directly", async () => {
    const repo = repositoryWithWorktrees(["lower"]);
    const { deps } = await open([repo.main, repo.at("lower")]);
    assert.deepEqual(await renameWorktree(deps, repo.worktree("lower"), "Lower"), { ok: true });
    assert.ok(fs.readdirSync(path.dirname(repo.at("lower"))).includes("Lower"));
    assert.equal(git(repo.at("Lower"), "branch", "--show-current"), "Lower");
  });

  it("carries its secret values over to the project reopened under a new id, and a delete drops them", async () => {
    const repo = repositoryWithWorktrees(["old-name"]);
    const { deps, store } = await open([repo.main, repo.at("old-name")]);
    // By name: the store keeps a folder in on-disk spelling (projects.ts's onDisk).
    const named = (name: string) => store.list().find((project) => path.basename(project.path) === name);
    const before = named("old-name");
    assert.ok(before);
    // Stored as the store keeps them, so no OS encryption is needed here.
    deps.sbxSecrets.restore(before.id, { GITLAB_TOKEN: "encrypted-value" });
    assert.deepEqual(await renameWorktree(deps, repo.worktree("old-name"), "new-name"), { ok: true });
    const after = named("new-name");
    assert.ok(after && after.id !== before.id, "reopened as a new project");
    assert.deepEqual(deps.sbxSecrets.encrypted(after.id), { GITLAB_TOKEN: "encrypted-value" });
    assert.deepEqual(deps.sbxSecrets.encrypted(before.id), {}, "the old id keeps nothing");
    assert.deepEqual(await deleteWorktree(deps, repo.worktree("new-name"), { force: true, onRemote: false }), { ok: true });
    assert.deepEqual(deps.sbxSecrets.encrypted(after.id), {}, "a deleted worktree's values go");
  });
});
