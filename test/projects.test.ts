import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { utilityProcess } from "electron";
import type { ControlRecords } from "../src/main/control/control-records";
import * as gitModule from "../src/main/git/git";
import type { GitRequest, GitResponse } from "../src/main/git/git-host";
import { RepositoryManager } from "../src/main/git/repository";
import { deleteWorktree, ProjectStore, renameWorktree, type ProjectDeps } from "../src/main/projects";
import type { SessionManagerRegistry } from "../src/main/terminals/session-manager";
import type { Project } from "../src/shared/types";

/**
 * projects.ts's worktree actions against the real git and real Repositories, the project's
 * sessions faked: which repository a command runs through, what closing the terminals may leave
 * behind, what a delete takes along. electron's `utilityProcess` runs git.ts in this process, as in
 * repository.test.ts.
 */

// Without the machine's config: a signing key or a hook there would turn a commit into a question.
const identity = {
  GIT_AUTHOR_NAME: "tet test",
  GIT_AUTHOR_EMAIL: "test@tet.invalid",
  GIT_COMMITTER_NAME: "tet test",
  GIT_COMMITTER_EMAIL: "test@tet.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "tet-projects-noglobal")
};
Object.assign(process.env, identity);
fs.writeFileSync(identity.GIT_CONFIG_GLOBAL, "");

const api = gitModule as unknown as Record<string, (...args: unknown[]) => unknown>;
Object.assign(utilityProcess, {
  fork: () => {
    let listener: (message: GitResponse) => void = () => undefined;
    return {
      on: (event: string, handler: (message: GitResponse) => void) => {
        if (event === "message") {
          listener = handler;
        }
      },
      postMessage: ({ id, method, args }: GitRequest) => {
        void (async () => {
          try {
            listener({ id, value: await api[method](...args) });
          } catch (error) {
            listener({ id, error: error instanceof Error ? error.message : String(error) });
          }
        })();
      },
      kill: () => undefined
    };
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const real = (folder: string): string => fs.realpathSync.native(folder);

/** A repository with a remote, and its linked worktrees `names`, each on a branch of that name
 *  published with an upstream. */
function repositoryWithWorktrees(names: string[]): { main: string; bare: string; at: (name: string) => string } {
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
  return { main, bare, at };
}

const managers: RepositoryManager[] = [];
after(() => managers.forEach((manager) => manager.disposeAll()));

/** The deps main.ts hands projects.ts, with the given folders open as projects. `onClose` runs as
 *  a project's sessions end — where a quitting agent could still write. */
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
    openProject: (project) => void repositories.open(project),
    dataRoot,
    projectsChanged: (change) => changes.push(change)
  };
  for (const folder of folders) {
    // open() starts it; refresh() is what can be awaited.
    await repositories.open(store.add(folder)).refresh();
  }
  return { deps, store, repositories, changes };
}

const remoteHas = (bare: string, branch: string): boolean => git(bare, "branch", "--list", branch) !== "";

describe("a worktree deleted with its main project closed", () => {
  let repo: ReturnType<typeof repositoryWithWorktrees>;

  before(() => {
    repo = repositoryWithWorktrees(["target", "sibling", "alone"]);
  });

  it("runs through a sibling worktree's repository, and deletes the upstream it was asked to", async () => {
    const { deps, store, repositories } = await open([repo.at("target"), repo.at("sibling")]);
    const sibling = repositories.get(store.list().find((project) => project.path === repo.at("sibling"))!.id)!;
    const result = await deleteWorktree(deps, { path: repo.at("target"), mainPath: repo.main }, { force: false, onRemote: true });
    assert.deepEqual(result, { ok: true });
    // Refreshed by its own action slot, not left for the watcher.
    assert.ok(!sibling.getState().worktrees.some((worktree) => worktree.branch === "target"), "run through the sibling");
    assert.ok(!fs.existsSync(repo.at("target")));
    assert.equal(git(repo.main, "branch", "--list", "target"), "", "the branch went with it");
    assert.ok(!remoteHas(repo.bare, "target"), "and its upstream, as asked");
  });

  it("is refused, before anything closes, with no project of the repository left to run it", async () => {
    const { deps, store, changes } = await open([repo.at("alone")]);
    const result = await deleteWorktree(deps, { path: repo.at("alone"), mainPath: repo.main }, { force: false, onRemote: true });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /^Open .+ to delete this worktree$/);
    assert.ok(fs.existsSync(repo.at("alone")));
    assert.ok(remoteHas(repo.bare, "alone"));
    assert.equal(store.list().length, 1, "its project still open");
    assert.deepEqual(changes, []);
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
    const result = await deleteWorktree(deps, { path: repo.at("busy"), mainPath: repo.main }, { force: false, onRemote: false });
    assert.deepEqual(result, { ok: false, uncommitted: true });
    assert.ok(fs.existsSync(path.join(repo.at("busy"), "late.txt")), "nothing deleted without the question");
    const forced = await deleteWorktree(deps, { path: repo.at("busy"), mainPath: repo.main }, { force: true, onRemote: false });
    assert.deepEqual(forced, { ok: true });
    assert.ok(!fs.existsSync(repo.at("busy")));
  });
});

describe("a worktree renamed to the folder it already has", () => {
  it("renames only the branch where the folder name stays, closing nothing", async () => {
    const repo = repositoryWithWorktrees([]);
    git(repo.main, "worktree", "add", "-q", "--relative-paths", "-b", "feature/x", repo.at("feature-x"));
    const { deps, changes } = await open([repo.main, repo.at("feature-x")]);
    const result = await renameWorktree(deps, { path: repo.at("feature-x"), mainPath: repo.main }, "feature-x");
    assert.deepEqual(result, { ok: true });
    assert.equal(git(repo.at("feature-x"), "branch", "--show-current"), "feature-x");
    assert.deepEqual(changes, [], "its project stays open");
  });

  it("moves the folder by case alone, where git refuses that directly", async () => {
    const repo = repositoryWithWorktrees(["lower"]);
    const { deps } = await open([repo.main, repo.at("lower")]);
    const result = await renameWorktree(deps, { path: repo.at("lower"), mainPath: repo.main }, "Lower");
    assert.deepEqual(result, { ok: true });
    assert.ok(fs.readdirSync(path.dirname(repo.at("lower"))).includes("Lower"));
    assert.equal(git(repo.at("Lower"), "branch", "--show-current"), "Lower");
  });
});
