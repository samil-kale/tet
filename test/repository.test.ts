import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { shell } from "electron";
import { Repository } from "../src/main/git/repository";
import { readMainWorktree } from "../src/main/git/linked-git-dir";
import { worktreeBase } from "../src/shared/types";
import { forkGitInProcess, git, initRepository, isolateGitConfig } from "./helpers";

/**
 * Repository against the real git, for what it composes beyond git.ts: the trash, the branch it
 * switches to, the question it hands back. electron's two pieces are faked: `utilityProcess` runs
 * git.ts in this process as git-host.ts would, `shell.trashItem` moves a file into a folder or fails.
 */

isolateGitConfig("tet-repository-noglobal");
forkGitInProcess();

const trash = fs.mkdtempSync(path.join(os.tmpdir(), "tet-trash-"));
/** Which paths the trash refuses. */
let trashRefuses: (absolute: string) => boolean = () => false;
let trashed = 0;
Object.assign(shell, {
  trashItem: async (absolute: string) => {
    if (trashRefuses(absolute)) {
      throw new Error("The trash is not available");
    }
    fs.renameSync(absolute, path.join(trash, `${++trashed}-${path.basename(absolute)}`));
  }
});

/** What the trash holds, oldest first. */
const trashContents = (): string[] =>
  fs
    .readdirSync(trash)
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map((name) => fs.readFileSync(path.join(trash, name), "utf8"));

const opened: Repository[] = [];

/** A started Repository on `dir`, disposed after the file. */
async function open(dir: string): Promise<Repository> {
  const repository = new Repository(
    { id: path.basename(dir), path: dir, name: path.basename(dir) },
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined
  );
  opened.push(repository);
  await repository.start();
  return repository;
}

after(() => opened.forEach((repository) => repository.dispose()));


describe("a discard, through the trash as in GitHub Desktop", () => {
  let dir: string;
  let repository: Repository;
  const edit = async (): Promise<void> => {
    fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
    await repository.refresh();
  };

  before(async () => {
    dir = initRepository("tet-repository-discard-");
    repository = await open(dir);
  });

  it("puts an edited file in the trash as well as an untracked one, and resets to HEAD", async () => {
    await edit();
    assert.deepEqual(await repository.discard(["a.txt", "new.txt"], false), { ok: true });
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "committed\n");
    assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
    assert.deepEqual(trashContents(), ["edited\n", "new\n"]);
    assert.deepEqual(repository.getState().changes, []);
  });

  it("resets nothing where the trash fails, and deletes when asked again", async () => {
    await edit();
    trashRefuses = () => true;
    try {
      const refused = await repository.discard(["a.txt", "new.txt"], false);
      assert.deepEqual(refused, { ok: false, error: "The trash is not available", needsConfirmation: "trash-failed" });
      assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "edited\n");
      assert.equal(fs.existsSync(path.join(dir, "new.txt")), true);

      assert.deepEqual(await repository.discard(["a.txt", "new.txt"], true), { ok: true });
      assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "committed\n");
      assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
      assert.deepEqual(repository.getState().changes, []);
    } finally {
      trashRefuses = () => false;
    }
  });

  it("still resets what went to the trash before the trash failed", async () => {
    await edit();
    trashRefuses = (absolute) => path.basename(absolute) === "new.txt";
    try {
      const refused = await repository.discard(["a.txt", "new.txt"], false);
      assert.deepEqual(refused, { ok: false, error: "The trash is not available", needsConfirmation: "trash-failed" });
      // Asked no further: a.txt is in the trash and back to HEAD, not missing.
      assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "committed\n");
      assert.equal(fs.existsSync(path.join(dir, "new.txt")), true);
      assert.deepEqual(repository.getState().changes, [{ path: "new.txt", status: "untracked" }]);
    } finally {
      trashRefuses = () => false;
    }
    assert.deepEqual(await repository.discard(["new.txt"], false), { ok: true });
  });

  it("puts an untracked repository inside it in the trash, whole", async () => {
    const outer = initRepository("tet-repository-nested-");
    const nested = path.join(outer, "nested");
    fs.mkdirSync(nested);
    git(nested, "init", "-q");
    fs.writeFileSync(path.join(nested, "n.txt"), "n\n");
    const holder = await open(outer);
    // A directory, not its files, even with --untracked-files=all.
    assert.deepEqual(holder.getState().changes, [{ path: "nested/", status: "untracked" }]);
    assert.deepEqual(await holder.discard(["nested/"], false), { ok: true });
    assert.equal(fs.existsSync(nested), false);
    assert.ok(fs.readdirSync(trash).some((name) => name.endsWith("-nested")));
    assert.deepEqual(holder.getState().changes, []);
  });
});

describe("a repository with a remote, as GitHub Desktop drives it", () => {
  let dir: string;
  let bare: string;
  let other: string;
  let repository: Repository;

  before(async () => {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "tet-repository-bare-"));
    git(bare, "init", "-q", "--bare", "--initial-branch=main");
    dir = initRepository("tet-repository-remote-");
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "second");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "--set-upstream", "origin", "main");
    git(dir, "remote", "set-head", "origin", "main");
    other = fs.mkdtempSync(path.join(os.tmpdir(), "tet-repository-other-"));
    git(other, "clone", "-q", bare, ".");
    repository = await open(dir);
  });

  it("hands a rebase over pushed commits back to be asked, and runs it once confirmed", async () => {
    git(dir, "branch", "older", "HEAD~1");
    await repository.refresh();
    const head = git(dir, "rev-parse", "HEAD");
    assert.deepEqual(await repository.rebase("older", false), { ok: false, needsConfirmation: "rewrites-pushed" });
    assert.equal(git(dir, "rev-parse", "HEAD"), head, "nothing was rebased");
    assert.deepEqual(await repository.rebase("older", true), { ok: true });
    git(dir, "branch", "-D", "older");
  });

  it("moves a branch only behind its upstream on a fetch", async () => {
    git(dir, "branch", "--track", "behind", "origin/main");
    fs.writeFileSync(path.join(other, "c.txt"), "c\n");
    git(other, "add", "c.txt");
    git(other, "commit", "-q", "-m", "third");
    git(other, "push", "-q");
    await repository.refresh();
    assert.deepEqual(await repository.fetch(), { ok: true });
    assert.equal(git(dir, "rev-parse", "behind"), git(dir, "rev-parse", "origin/main"));
    assert.equal(repository.getState().branchTrack.behind, undefined, "level with its upstream");
    git(dir, "branch", "-D", "behind");
  });

  it("switches to the default branch before deleting the checked-out one, and deletes its upstream", async () => {
    git(dir, "switch", "-q", "--create", "feature");
    git(dir, "push", "-q", "--set-upstream", "origin", "feature");
    await repository.refresh();
    assert.deepEqual(repository.getState().defaultBranch, { name: "main" });
    assert.deepEqual(await repository.deleteBranch("feature", true), { ok: true });
    const state = repository.getState();
    assert.equal(state.head, "main");
    assert.deepEqual(state.localBranches, ["main"]);
    assert.equal(git(bare, "branch", "--list", "feature"), "", "gone from the remote too");
  });

  it("refuses to delete the checked-out branch with no default branch to switch to", async () => {
    git(dir, "remote", "set-head", "origin", "--delete");
    git(dir, "branch", "-m", "main", "trunk");
    git(dir, "switch", "-q", "--create", "lonely");
    await repository.refresh();
    assert.equal(repository.getState().defaultBranch, undefined);
    const refused = await repository.deleteBranch("lonely", false);
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? "", /no default branch/);
    assert.ok(repository.getState().localBranches.includes("lonely"));
  });
});

describe("worktrees, each with a branch of its own", () => {
  let dir: string;
  let worktrees: string;
  let repository: Repository;
  const at = (name: string): string => path.join(worktrees, name);
  const real = (folder: string): string => fs.realpathSync.native(folder);

  before(async () => {
    dir = initRepository("tet-repository-wt-");
    // A base behind HEAD, so a worktree's start is told from HEAD.
    git(dir, "branch", "base");
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "ahead of base");
    worktrees = fs.mkdtempSync(path.join(os.tmpdir(), "tet-repository-wts-"));
    repository = await open(dir);
  });

  it("makes a new branch at its base, untracked, recorded, linked relatively", async () => {
    assert.deepEqual(await repository.addWorktree(at("fresh"), "fresh", { name: "base" }), { ok: true });
    assert.equal(git(at("fresh"), "branch", "--show-current"), "fresh");
    assert.equal(git(at("fresh"), "rev-parse", "HEAD"), git(dir, "rev-parse", "base"));
    assert.equal(git(dir, "config", "branch.fresh.base"), "base");
    assert.equal(spawnSync("git", ["config", "branch.fresh.merge"], { cwd: dir }).status, 1, "no upstream");
    assert.match(fs.readFileSync(path.join(at("fresh"), ".git"), "utf8"), /^gitdir: \.\./);
    assert.equal(readMainWorktree(at("fresh")), real(dir));
    assert.equal(readMainWorktree(dir), undefined, "the main worktree is none");
  });

  it("never takes a branch that exists", async () => {
    const refused = await repository.addWorktree(at("taken"), "fresh", { name: "main" });
    assert.equal(refused.ok, false);
    assert.ok(!fs.existsSync(at("taken")));
  });

  it("lists the worktrees off the disk, main first, with their branches and bases", async () => {
    assert.deepEqual(await repository.addWorktree(at("second"), "second", { name: "main" }), { ok: true });
    // One made outside tet has no base.
    git(dir, "worktree", "add", "-q", "-b", "third", at("third"));
    const { worktrees: listed } = await repository.refresh();
    assert.deepEqual(listed[0], { path: real(dir), branch: "main", base: undefined, main: true, current: true });
    assert.deepEqual(listed.slice(1), [
      { path: real(at("fresh")), branch: "fresh", base: "base", main: false, current: false },
      { path: real(at("second")), branch: "second", base: "main", main: false, current: false },
      { path: real(at("third")), branch: "third", base: undefined, main: false, current: false }
    ]);
    git(dir, "worktree", "remove", at("third"));
    git(at("fresh"), "switch", "-q", "--detach");
    assert.equal((await repository.refresh()).worktrees[1]?.branch, undefined, "a detached one has none");
    git(at("fresh"), "switch", "-q", "fresh");
  });

  it("is the current one when read in a linked worktree", async () => {
    const linked = await open(at("second"));
    const current = linked.getState().worktrees.filter((worktree) => worktree.current);
    assert.deepEqual(current.map((worktree) => worktree.branch), ["second"]);
    assert.equal(linked.getState().worktrees[0]?.path, real(dir), "main still first");
    linked.dispose();
  });

  it("removes a worktree with changes only when forced", async () => {
    fs.writeFileSync(path.join(at("second"), "new.txt"), "new\n");
    const refused = await repository.removeWorktree(at("second"), false);
    assert.equal(refused.ok, false);
    assert.ok(fs.existsSync(at("second")));
    assert.deepEqual(await repository.removeWorktree(at("second"), true), { ok: true });
    assert.ok(!fs.existsSync(at("second")));
    assert.ok(!repository.getState().worktrees.some((worktree) => worktree.branch === "second"));
  });

  it("renames a branch checked out in a worktree, which follows it with its base, and moves the folder", async () => {
    assert.deepEqual(await repository.renameBranch("fresh", "renamed"), { ok: true });
    assert.equal(git(at("fresh"), "branch", "--show-current"), "renamed");
    assert.equal(git(dir, "config", "branch.renamed.base"), "base");
    assert.deepEqual(await repository.moveWorktree(at("fresh"), at("renamed")), { ok: true });
    assert.equal(git(at("renamed"), "branch", "--show-current"), "renamed");
    // Still relative, or a sandbox loses it.
    assert.match(fs.readFileSync(path.join(at("renamed"), ".git"), "utf8"), /^gitdir: \.\./);
  });

  // What projects.ts's renameWorktree does for a rename by case alone, which git refuses directly
  // where names are case-insensitive (measured on win32: "Invalid argument").
  it("moves a worktree by case alone through a name of its own", async () => {
    assert.deepEqual(await repository.moveWorktree(at("renamed"), at("Renamed.tet-rename")), { ok: true });
    assert.deepEqual(await repository.moveWorktree(at("Renamed.tet-rename"), at("Renamed")), { ok: true });
    assert.ok(fs.readdirSync(worktrees).includes("Renamed"));
    assert.equal(git(at("Renamed"), "branch", "--show-current"), "renamed");
    assert.deepEqual(await repository.moveWorktree(at("Renamed"), at("back.tet-rename")), { ok: true });
    assert.deepEqual(await repository.moveWorktree(at("back.tet-rename"), at("renamed")), { ok: true });
  });

  it("forgets a worktree whose folder is gone", async () => {
    fs.rmSync(at("renamed"), { recursive: true, force: true });
    assert.deepEqual(await repository.pruneWorktrees(), { ok: true });
    assert.deepEqual(repository.getState().worktrees.map((worktree) => worktree.branch), ["main"]);
  });
});

describe("where a worktree starts without a remote HEAD", () => {
  it("is the main worktree's branch when no default branch is known", async () => {
    // No remote, and a branch other than init.defaultBranch's ("main" while unset): as `git init`
    // with an older git or another default leaves it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-repository-trunk-"));
    git(dir, "init", "-q", "--initial-branch=trunk");
    git(dir, "commit", "-q", "--allow-empty", "-m", "base");
    const repository = await open(dir);
    assert.equal(repository.getState().defaultBranch, undefined);
    assert.deepEqual(worktreeBase(repository.getState()), { name: "trunk" });
  });
});
