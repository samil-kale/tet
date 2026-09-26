import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { shell } from "electron";
import { GitLoginStore } from "../src/main/git-logins";
import * as git_ from "../src/main/git/git";
import { Repository } from "../src/main/git/repository";
import { readMainWorktree } from "../src/main/git/linked-git-dir";
import { worktreeBase } from "../src/shared/types";
import type { FileSearchQuery, FileSearchResult } from "../src/shared/types";
import { fakeSafeStorage, forkGitInProcess, git, initBare, initRepository, isolateGitConfig, serveOverHttp, type HttpRemote } from "./helpers";

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

/** A started Repository on `dir`, disposed after the file. `worktreeKeyOf` stands in for
 *  project-dirs.ts's: which worktrees TET made. */
async function open(
  dir: string,
  // The remotes are mostly folders, which take no login.
  logins = new GitLoginStore(fs.mkdtempSync(path.join(os.tmpdir(), "tet-logins-"))),
  worktreeKeyOf: (worktreePath: string) => string | undefined = () => undefined
): Promise<Repository> {
  const repository = new Repository(
    { ref: { projectId: path.basename(dir) }, path: dir, name: () => path.basename(dir) },
    worktreeKeyOf,
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
    logins
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

describe("a command clicked during the periodic fetch", () => {
  it("does not run once the repository closed meanwhile", async () => {
    const dir = initRepository("tet-repository-closed-");
    const repository = await open(dir);
    let fetched = (): void => undefined;
    // The fetch underway, held and cleared as autoFetch does.
    Object.assign(repository, { autoFetching: new Promise<void>((resolve) => (fetched = resolve)) });
    const clicked = repository.createBranch("late", "main");
    const closed = repository.dispose();
    fetched();
    Object.assign(repository, { autoFetching: undefined });
    await closed;
    assert.equal((await clicked).ok, false);
    assert.equal(git(dir, "branch", "--list", "late"), "", "no git started in the closed folder");
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
    // "second" stands for one TET made, the others for ones made elsewhere.
    repository = await open(dir, undefined, (worktreePath) => (path.basename(worktreePath) === "second" ? "k2" : undefined));
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

  it("lists the worktrees off the disk, main first, with their branches, bases and TET's keys", async () => {
    assert.deepEqual(await repository.addWorktree(at("second"), "second", { name: "main" }), { ok: true });
    // One made outside tet has no base.
    git(dir, "worktree", "add", "-q", "-b", "third", at("third"));
    const { worktrees: listed } = await repository.refresh();
    assert.deepEqual(listed[0], { path: real(dir), branch: "main", base: undefined, key: undefined, main: true, current: true });
    assert.deepEqual(listed.slice(1), [
      { path: real(at("fresh")), branch: "fresh", base: "base", key: undefined, main: false, current: false },
      { path: real(at("second")), branch: "second", base: "main", key: "k2", main: false, current: false },
      { path: real(at("third")), branch: "third", base: undefined, key: undefined, main: false, current: false }
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

  // A worktree's rename: its folder stays (projects.ts).
  it("renames a branch checked out in a worktree, which follows it with its base", async () => {
    assert.deepEqual(await repository.renameBranch("fresh", "renamed"), { ok: true });
    assert.equal(git(at("fresh"), "branch", "--show-current"), "renamed");
    assert.equal(git(dir, "config", "branch.renamed.base"), "base");
  });

  it("forgets a worktree whose folder is gone", async () => {
    fs.rmSync(at("fresh"), { recursive: true, force: true });
    assert.deepEqual(await repository.pruneWorktrees(), { ok: true });
    assert.deepEqual(repository.getState().worktrees.map((worktree) => worktree.branch), ["main"]);
  });
});

describe("where a worktree starts without a remote HEAD", () => {
  it("is the repository's branch when no default branch is known", async () => {
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

describe("the Explorer's search, VS Code's search in files", () => {
  let dir: string;
  let repository: Repository;

  const search = (query: Partial<FileSearchQuery>): Promise<FileSearchResult> =>
    repository.searchFiles({
      text: "",
      matchCase: false,
      wholeWord: false,
      regex: false,
      ...query
    });
  /** Files and their matches as `path:line:column`, which is what the row opens. */
  const found = (result: FileSearchResult): string[] =>
    result.files.flatMap((file) => file.matches.map((match) => `${file.path}:${match.line}:${match.column}`));

  before(async () => {
    dir = initRepository("tet-repository-search-");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "const needle = 1;\n  needle();\n");
    fs.writeFileSync(path.join(dir, "src", "b.txt"), "NEEDLE haystack\nneedless\n");
    // Ignored and binary: the tree lists both, the search reads neither.
    fs.writeFileSync(path.join(dir, ".gitignore"), "out/\n");
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "built.js"), "needle\n");
    fs.writeFileSync(path.join(dir, "src", "bin.dat"), Buffer.from([0x6e, 0x00, 0x65]));
    repository = await open(dir);
  });

  it("finds every match in the listed files, and hands the row the line without its indent", async () => {
    const result = await search({ text: "needle" });
    assert.deepEqual(found(result), ["src/a.ts:1:7", "src/a.ts:2:3", "src/b.txt:1:1", "src/b.txt:2:1"]);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.files[0].matches[1], { line: 2, column: 3, length: 6, text: "needle();", textColumn: 0 });
  });

  it("keeps the indent in the row where the match reaches into it", async () => {
    const result = await search({ text: "^\\s+needle", regex: true });
    assert.deepEqual(result.files[0].matches, [{ line: 2, column: 1, length: 8, text: "  needle();", textColumn: 0 }]);
  });

  it("reads neither what git ignores nor a binary file, both of which the tree lists", async () => {
    assert.deepEqual(found(await search({ text: "needle" })).filter((match) => match.startsWith("out/")), []);
    assert.deepEqual(found(await search({ text: "n" })).filter((match) => match.startsWith("src/bin")), []);
    const listing = await repository.listExplorer();
    assert.deepEqual(listing.files.includes("out/built.js") && listing.files.includes("src/bin.dat"), true);
  });

  it("takes the case, whole-word and regex toggles, and reports a regex that will not parse", async () => {
    assert.deepEqual(found(await search({ text: "needle", matchCase: true })), [
      "src/a.ts:1:7",
      "src/a.ts:2:3",
      "src/b.txt:2:1"
    ]);
    assert.deepEqual(found(await search({ text: "needle", wholeWord: true })), [
      "src/a.ts:1:7",
      "src/a.ts:2:3",
      "src/b.txt:1:1"
    ]);
    assert.deepEqual(found(await search({ text: "n..dle\\(", regex: true })), ["src/a.ts:2:3"]);
    const broken = await search({ text: "(", regex: true });
    assert.deepEqual(broken.files, []);
    assert.equal(typeof broken.error, "string");
  });

  it("stops at the match cap without listing a file it then has no match for", async () => {
    // Three files read at once, each more than half the cap: the two that land after it is reached
    // are cut, and a file cut to nothing is no result.
    const capped = fs.mkdtempSync(path.join(os.tmpdir(), "tet-repository-capped-"));
    git(capped, "init", "-q", "--initial-branch=main");
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      fs.writeFileSync(path.join(capped, name), "needle\n".repeat(1500));
    }
    const result = await (await open(capped)).searchFiles({
      text: "needle",
      matchCase: false,
      wholeWord: false,
      regex: false
    });
    assert.equal(result.truncated, true);
    assert.equal(
      result.files.reduce((count, file) => count + file.matches.length, 0),
      2000
    );
    assert.deepEqual(result.files.filter((file) => file.matches.length === 0), []);
  });
});


describe("a remote over http that wants a login", () => {
  const login = { username: "saka", password: "right" };
  before(() => fakeSafeStorage());

  /** A repository whose origin is served over http, opened with its own login store. git runs
   *  against the remote only asynchronously here: a sync spawn would stop the server answering it. */
  async function openWithHttpRemote(): Promise<{
    dir: string;
    bare: string;
    repository: Repository;
    logins: GitLoginStore;
    remote: HttpRemote;
  }> {
    const bare = initBare("tet-http-remote-");
    const remote = await serveOverHttp(bare, login);
    const dir = initRepository("tet-http-work-");
    git(dir, "remote", "add", "origin", remote.url);
    const logins = new GitLoginStore(fs.mkdtempSync(path.join(os.tmpdir(), "tet-logins-")));
    const repository = await open(dir, logins);
    return { dir, bare, repository, logins, remote };
  }

  it("asks where git has no login, keeps the one that worked, and uses it from then on", async () => {
    const { dir, repository, logins, remote } = await openWithHttpRemote();
    try {
      const asked = await repository.push();
      assert.equal(asked.ok, false);
      assert.equal(asked.loginUrl, remote.url);

      const refused = await repository.push({ username: "saka", password: "wrong" });
      assert.equal(refused.loginUrl, remote.url, "a wrong login is asked for again");
      assert.equal(logins.get(remote.url), undefined, "and not kept");

      assert.deepEqual(await repository.push(login), { ok: true });
      assert.deepEqual(logins.get(remote.url), login, "no credential helper: tet keeps it");
      assert.equal(git(dir, "rev-parse", "origin/main"), git(dir, "rev-parse", "main"));

      fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
      git(dir, "add", "b.txt");
      git(dir, "commit", "-q", "-m", "b");
      await repository.refresh();
      assert.deepEqual(await repository.push(), { ok: true }, "the kept login, unasked");
      assert.deepEqual(await repository.fetch(), { ok: true });
      assert.deepEqual(await repository.pull(), { ok: true });
    } finally {
      remote.close();
    }
  });

  it("forgets a kept login the host refuses, and asks again", async () => {
    const { repository, logins, remote } = await openWithHttpRemote();
    try {
      logins.set(remote.url, login);
      assert.deepEqual(await repository.push(), { ok: true });
      remote.login.password = "rotated";
      const asked = await repository.fetch();
      assert.equal(asked.loginUrl, remote.url);
      assert.equal(logins.get(remote.url), undefined);
      assert.deepEqual(await repository.fetch({ username: "saka", password: "rotated" }), { ok: true });
      assert.equal(logins.get(remote.url)?.password, "rotated");
    } finally {
      remote.close();
      remote.login.password = login.password;
    }
  });

  it("leaves a login to the credential helper where there is one", async () => {
    const { dir, repository, logins, remote } = await openWithHttpRemote();
    const helperFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tet-helper-")), "credentials");
    git(dir, "config", "credential.helper", `store --file=${helperFile.replace(/\\/g, "/")}`);
    try {
      assert.equal((await repository.push()).loginUrl, remote.url);
      assert.deepEqual(await repository.push(login), { ok: true });
      assert.equal(logins.get(remote.url), undefined, "tet keeps nothing");
      assert.match(fs.readFileSync(helperFile, "utf8"), /saka:right@127\.0\.0\.1/, "git stored it in the helper");
      assert.deepEqual(await repository.fetch(), { ok: true }, "the helper answers from then on");

      remote.login.password = "rotated";
      assert.equal((await repository.fetch()).loginUrl, remote.url);
      assert.doesNotMatch(fs.readFileSync(helperFile, "utf8"), /saka:right/, "git erased the refused one from the helper");
    } finally {
      remote.close();
      remote.login.password = login.password;
    }
  });

  it("tries only the remote half again after a delete that wanted a login", async () => {
    const { dir, bare, repository, logins, remote } = await openWithHttpRemote();
    try {
      logins.set(remote.url, login);
      git(dir, "tag", "-a", "-m", "v", "v1");
      assert.deepEqual(await repository.createBranch("gone", "main"), { ok: true });
      assert.deepEqual(await repository.push(), { ok: true }, "publishes gone, tracking it");
      assert.deepEqual(await repository.checkout({ name: "main" }), { ok: true });
      assert.deepEqual(await repository.pushTag("v1"), { ok: true });
      logins.delete(remote.url, login.username);

      const branch = await repository.deleteBranch("gone", true);
      assert.equal(branch.loginUrl, remote.url, "the local branch went, its upstream wants a login");
      assert.deepEqual(await repository.deleteRemoteBranch("origin", "gone", login), { ok: true });
      assert.deepEqual(logins.get(remote.url), login, "kept again once it worked");
      logins.delete(remote.url, login.username);
      const tag = await repository.deleteTag("v1", true);
      assert.equal(tag.loginUrl, remote.url);
      assert.deepEqual(await repository.deleteRemoteTag("v1", login), { ok: true });
      assert.doesNotMatch(git(bare, "for-each-ref"), /refs\/heads\/gone|refs\/tags\/v1/);
    } finally {
      remote.close();
    }
  });

  it("clones with a login, as the add-repository dialog does", async () => {
    const bare = initBare("tet-http-clone-remote-");
    const seed = initRepository("tet-http-seed-");
    git(seed, "push", "-q", bare, "main");
    const remote = await serveOverHttp(bare, login);
    const logins = new GitLoginStore(fs.mkdtempSync(path.join(os.tmpdir(), "tet-logins-")));
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tet-http-clone-")), "app");
    const clone = (typed?: typeof login) =>
      logins.run(os.homedir(), remote.url, typed, (networkLogin) => git_.clone(remote.url, target, networkLogin));
    try {
      assert.equal((await clone()).loginUrl, remote.url);
      assert.deepEqual(await clone(login), { ok: true });
      assert.equal(fs.readFileSync(path.join(target, "a.txt"), "utf8"), "committed\n");
      assert.deepEqual(logins.get(remote.url), login);
    } finally {
      remote.close();
    }
  });
});
