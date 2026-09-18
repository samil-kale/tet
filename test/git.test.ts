import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import {
  abortOperation,
  commitAll,
  commitPaths,
  createBranch,
  createTag,
  deleteRemoteBranch,
  discard,
  ensureAskpass,
  fastForwardBranches,
  fetch,
  ignorePath,
  isRepository,
  listIgnored,
  merge,
  pull,
  push,
  readCommitContext,
  readHeadBlob,
  readHeadPaths,
  readState,
  rebaseRewritesPushed,
  renameBranch,
  resolveRoot,
  stashDrop,
  stashPush,
  updateRemoteHead
} from "../src/main/git/git";
import { git, isolateGitConfig } from "./helpers";

/**
 * git.ts against the real git, in a repository built up step by step. It imports nothing from
 * electron, so it runs in this process.
 */

isolateGitConfig("tet-git-noglobal");

let cwd: string;

const run = (...args: string[]): string => git(cwd, ...args);

const write = (name: string, content: string): void => fs.writeFileSync(path.join(cwd, name), content);

/** The editor tab's read cap; `readHeadBlob` takes it per call. */
const MAX_BYTES = 4 * 1024 * 1024;
const head = (name: string, origPath?: string) => readHeadBlob(cwd, name, { origPath, maxBytes: MAX_BYTES });
const changed = async (): Promise<string[]> =>
  (await readState(cwd)).changes.map((change) => `${change.status} ${change.path}`).sort();

describe("a repository, from init on", () => {
  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-"));
    run("init", "-q");
    run("symbolic-ref", "HEAD", "refs/heads/main");
  });

  it("is unborn: a branch name and nothing else", async () => {
    const state = await readState(cwd);
    assert.equal(state.error, undefined);
    assert.equal(state.head, "main");
    assert.equal(state.detached, false);
    assert.deepEqual(state.localBranches, []);
    assert.deepEqual(state.changes, []);
    assert.deepEqual(state.stashes, []);
    assert.equal(state.operation, undefined);
    assert.equal(await isRepository(cwd), true);
    assert.equal(await isRepository(os.tmpdir()), false);
    // HEAD does not resolve: every file reads as one HEAD never had.
    assert.deepEqual(await head("a.txt"), { content: "", binary: false, missing: true });
  });

  it("shows a new file as untracked, with nothing in HEAD to diff it against", async () => {
    write("a.txt", "one\ntwo\nthree\n");
    assert.deepEqual((await readState(cwd)).changes, [{ path: "a.txt", status: "untracked" }]);
    assert.deepEqual(await head("a.txt"), { content: "", binary: false, missing: true });
    // Unborn: nothing is in HEAD, and asking is no error.
    assert.deepEqual(await readHeadPaths(cwd, ["a.txt"]), []);
  });

  it("hands a staged file to the commit message before there is a HEAD", async () => {
    // A `git add` before the first commit: not untracked, and no HEAD to diff against.
    run("add", "a.txt");
    assert.match(await readCommitContext(cwd), /\+two/);
    run("rm", "-q", "--cached", "a.txt");
  });

  it("commits everything and is clean again", async () => {
    assert.deepEqual(await commitAll(cwd, "first"), { ok: true });
    const state = await readState(cwd);
    assert.deepEqual(state.changes, []);
    assert.deepEqual(state.localBranches, ["main"]);
  });

  it("reads the committed version of a modified file, whole, and discards the change", async () => {
    write("a.txt", "one\n2\nthree\n");
    assert.deepEqual((await readState(cwd)).changes, [{ path: "a.txt", status: "modified" }]);
    // Byte for byte, trailing newline included: an invented newline would diff as a change.
    assert.deepEqual(await head("a.txt"), {
      content: "one\ntwo\nthree\n",
      binary: false,
      missing: false
    });
    assert.deepEqual(await discard(cwd, { restore: ["a.txt"], drop: [] }), { ok: true });
    assert.deepEqual((await readState(cwd)).changes, []);
  });

  it("calls a blob past the cap binary, the way node reports the overflow", async () => {
    // The cap is maxBuffer: node kills git mid-stream with a code of its own, which tells "too
    // large" apart from a path HEAD does not have.
    assert.deepEqual(await readHeadBlob(cwd, "a.txt", { maxBytes: 4 }), {
      content: "",
      binary: true,
      missing: false
    });
  });

  it("calls a blob with a NUL byte binary, and reads an image as a data url", async () => {
    fs.writeFileSync(path.join(cwd, "blob.bin"), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(cwd, "pic.png"), Buffer.from([137, 80, 78, 71]));
    assert.deepEqual(await commitAll(cwd, "a binary and an image"), { ok: true });
    assert.deepEqual(await head("blob.bin"), { content: "", binary: true, missing: false });
    const image = await head("pic.png");
    assert.equal(image.binary, true);
    assert.match(image.image ?? "", /^data:image\/png;base64,/);
  });

  it("puts the blob through the checkout filters, so it reads like the working tree", async () => {
    // Why HEAD is read with `cat-file --filters`, not `show`: git stores LF, the working tree has
    // CRLF, and only the filtered text compares with what the editor holds.
    write(".gitattributes", "crlf.txt text eol=crlf\n");
    write("crlf.txt", "one\ntwo\n");
    assert.deepEqual(await commitAll(cwd, "a file checked out with crlf"), { ok: true });
    assert.equal((await head("crlf.txt")).content, "one\r\ntwo\r\n");
  });

  it("reads a staged rename as one change with its old path", async () => {
    run("mv", "a.txt", "b.txt");
    assert.deepEqual((await readState(cwd)).changes, [{ path: "b.txt", status: "renamed", origPath: "a.txt" }]);
    // HEAD knows only the old path; without it every line would read as new.
    assert.equal((await head("b.txt", "a.txt")).content, "one\ntwo\nthree\n");
    assert.equal((await head("b.txt")).missing, true);
    assert.deepEqual(await commitAll(cwd, "rename"), { ok: true });
  });

  it("lists tags and branches, and switches to a created branch", async () => {
    assert.deepEqual(await createTag(cwd, "v1", "HEAD", ""), { ok: true });
    // Without a message too, as in GitHub Desktop.
    assert.equal(run("cat-file", "-t", "refs/tags/v1"), "tag");
    assert.deepEqual(await createBranch(cwd, "feature", "main"), { ok: true });
    const state = await readState(cwd);
    assert.equal(state.head, "feature");
    assert.deepEqual(state.localBranches, ["feature", "main"]);
    assert.deepEqual(state.tags, ["v1"]);
  });

  it("stashes the changes and lists the stash by its ref and commit", async () => {
    write("b.txt", "changed\n");
    assert.deepEqual(await stashPush(cwd, "wip"), { ok: true });
    const state = await readState(cwd);
    assert.deepEqual(state.changes, []);
    assert.equal(state.stashes.length, 1);
    assert.equal(state.stashes[0].ref, "stash@{0}");
    assert.equal(state.stashes[0].sha, run("rev-parse", "stash@{0}"));
    assert.match(state.stashes[0].message, /wip/);
    assert.deepEqual(await stashDrop(cwd, state.stashes[0].sha), { ok: true });
    assert.deepEqual((await readState(cwd)).stashes, []);
  });

  it("drops the stash it was shown, though a newer one renumbered it", async () => {
    write("b.txt", "first\n");
    assert.deepEqual(await stashPush(cwd, "first"), { ok: true });
    const [shown] = (await readState(cwd)).stashes;
    // A terminal stashes meanwhile: "first" is stash@{1} now.
    write("b.txt", "second\n");
    run("stash", "push", "-q", "-m", "second");
    assert.deepEqual(await stashDrop(cwd, shown.sha), { ok: true });
    const left = (await readState(cwd)).stashes;
    assert.equal(left.length, 1);
    assert.match(left[0].message, /second/);
    assert.deepEqual(await stashDrop(cwd, shown.sha), { ok: false, error: "The stash no longer exists" });
    run("stash", "drop", "-q");
  });

  it("reports a merge stopped on a conflict, and aborts it", async () => {
    write("b.txt", "feature line\n");
    assert.deepEqual(await commitAll(cwd, "on feature"), { ok: true });
    run("switch", "-q", "main");
    write("b.txt", "main line\n");
    assert.deepEqual(await commitAll(cwd, "on main"), { ok: true });
    const merged = await merge(cwd, "feature");
    assert.equal(merged.ok, false);
    assert.doesNotMatch(merged.error ?? "", /^hint:/m, "the advice block is left out");
    const conflicted = await readState(cwd);
    assert.equal(conflicted.operation, "merge");
    assert.deepEqual(conflicted.changes, [{ path: "b.txt", status: "conflicted" }]);
    assert.deepEqual(await abortOperation(cwd, "merge"), { ok: true });
    const clean = await readState(cwd);
    assert.equal(clean.operation, undefined);
    assert.deepEqual(clean.changes, []);
  });

  it("publishes to a remote and counts what is ahead of it", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tet-bare-"));
    assert.equal(spawnSync("git", ["init", "-q", "--bare", bare]).status, 0);
    run("remote", "add", "origin", bare);
    assert.deepEqual(await push(cwd, "origin", "main", undefined), { ok: true });
    run("remote", "set-head", "origin", "main");
    let state = await readState(cwd);
    assert.equal(state.upstream, "origin/main");
    assert.deepEqual(state.branchUpstreams, { main: { remote: "origin", branch: "main" } });
    assert.deepEqual([state.ahead, state.behind], [0, 0]);
    assert.deepEqual(state.remotes, [{ name: "origin", branches: ["main"] }]);
    assert.deepEqual(state.defaultBranch, { name: "main" });
    write("c.txt", "new\n");
    assert.deepEqual(await commitAll(cwd, "ahead"), { ok: true });
    state = await readState(cwd);
    assert.deepEqual([state.ahead, state.behind], [1, 0]);
    assert.deepEqual(state.branchTrack, {}, "only the checked-out branch, from the header");
    // Same branch, another commit (a pull or reset): what an open file reloads on.
    assert.equal(state.headCommit, run("rev-parse", "HEAD"));
    run("reset", "-q", "--hard", "HEAD~1");
    assert.equal((await readState(cwd)).headCommit, run("rev-parse", "HEAD"));
    run("reset", "-q", "--hard", "HEAD@{1}");
  });

  it("creates a branch from a remote branch without tracking it", async () => {
    assert.deepEqual(await createBranch(cwd, "from-remote", "origin/main"), { ok: true });
    assert.equal((await readState(cwd)).upstream, undefined);
    run("switch", "-q", "main");
    run("branch", "-q", "-D", "from-remote");
  });

  it("hides what .gitignore hides, added the way the menu adds it", async () => {
    write("debug.log", "noise\n");
    assert.deepEqual(await ignorePath(cwd, "debug.log", "extension"), { ok: true });
    assert.match(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"), /^\*\.log$/m);
    assert.ok((await listIgnored(cwd)).includes("debug.log"));
    const paths = (await readState(cwd)).changes.map((entry) => entry.path);
    assert.deepEqual(paths, [".gitignore"]);
  });

  it("shows a detached HEAD as a commit id", async () => {
    run("checkout", "-q", "--detach");
    const state = await readState(cwd);
    assert.equal(state.detached, true);
    assert.match(state.head, /^[0-9a-f]{7,}$/);
    assert.equal(state.upstream, undefined);
  });

  it("resolves the root from a subdirectory", async () => {
    const sub = path.join(cwd, "deep", "er");
    fs.mkdirSync(sub, { recursive: true });
    // Not realpathSync(cwd): it leaves an 8.3 short %TEMP% on Windows unexpanded, git expands it.
    assert.equal(await resolveRoot(sub), await resolveRoot(cwd));
    assert.equal(await resolveRoot(os.tmpdir()), undefined);
  });
});

describe("a selection of the changes, as the list's menu hands it over", () => {
  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-selection-"));
    run("init", "-q");
    run("symbolic-ref", "HEAD", "refs/heads/main");
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    run("add", "--all");
    run("commit", "-q", "--message", "base");
  });

  it("reads the commit context of the selection alone", async () => {
    write("a.txt", "a changed\n");
    write("b.txt", "b changed\n");
    write("new.txt", "new\n");
    write("other.txt", "other\n");
    const context = await readCommitContext(cwd, ["a.txt", "new.txt"]);
    assert.match(context, /a changed/);
    assert.match(context, /=== untracked: new\.txt ===/);
    assert.doesNotMatch(context, /b changed/);
    assert.doesNotMatch(context, /other\.txt/);
  });

  it("commits the selection, untracked files included, and leaves what is already staged", async () => {
    run("add", "b.txt");
    assert.deepEqual(await commitPaths(cwd, "selection", ["a.txt", "new.txt"], ["new.txt"]), { ok: true });
    assert.equal(run("show", "--name-only", "--format=", "HEAD"), "a.txt\nnew.txt");
    assert.deepEqual(await changed(), ["modified b.txt", "untracked other.txt"]);
  });

  it("commits a rename handed over by both its paths", async () => {
    run("mv", "a.txt", "renamed.txt");
    assert.deepEqual(await commitPaths(cwd, "rename", ["renamed.txt", "a.txt"], []), { ok: true });
    assert.deepEqual(await changed(), ["modified b.txt", "untracked other.txt"]);
  });

  it("takes a path with glob characters as that one file, never as a pattern", async () => {
    // A Next.js route folder: read as a pattern, "[id]" also matches a folder named "i".
    for (const dir of ["[id]", "i"]) {
      fs.mkdirSync(path.join(cwd, dir));
      write(`${dir}/page.txt`, "page\n");
    }
    // Literal, and only these two: b.txt is still staged from the test before.
    run("--literal-pathspecs", "add", "--", "[id]", "i");
    run("--literal-pathspecs", "commit", "-q", "--message", "routes", "--", "[id]", "i");
    write("[id]/page.txt", "id changed\n");
    write("i/page.txt", "i changed\n");
    const context = await readCommitContext(cwd, ["[id]/page.txt"]);
    assert.doesNotMatch(context, /i changed/);
    assert.deepEqual(await discard(cwd, { restore: ["[id]/page.txt"], drop: [] }), { ok: true });
    assert.deepEqual(await changed(), ["modified b.txt", "modified i/page.txt", "untracked other.txt"]);
    write("[id]/page.txt", "id changed\n");
    assert.deepEqual(await commitPaths(cwd, "route", ["[id]/page.txt"], []), { ok: true });
    assert.deepEqual(await changed(), ["modified b.txt", "modified i/page.txt", "untracked other.txt"]);
  });

  it("shows a file untracked by `rm --cached` as one untracked row, not a deletion beside it", async () => {
    run("rm", "-q", "--cached", "renamed.txt");
    write("renamed.txt", "edited\n");
    // git reports both, "D  renamed.txt" and "?? renamed.txt"; GitHub Desktop shows the second.
    assert.deepEqual(await changed(), [
      "modified b.txt",
      "modified i/page.txt",
      "untracked other.txt",
      "untracked renamed.txt"
    ]);
  });

  it("discards that file back to HEAD's version, once the edited one is trashed", async () => {
    // Only HEAD knows it is more than an untracked file.
    assert.deepEqual(await readHeadPaths(cwd, ["renamed.txt", "other.txt"]), ["renamed.txt"]);
    // What Repository.discard does for it: the edits go to the trash first.
    const trash = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-trash-"));
    fs.renameSync(path.join(cwd, "renamed.txt"), path.join(trash, "renamed.txt"));
    assert.deepEqual(await discard(cwd, { restore: ["renamed.txt"], drop: [] }), { ok: true });
    assert.equal(fs.readFileSync(path.join(cwd, "renamed.txt"), "utf8"), "a changed\n");
    assert.equal(fs.readFileSync(path.join(trash, "renamed.txt"), "utf8"), "edited\n");
    assert.deepEqual(await changed(), ["modified b.txt", "modified i/page.txt", "untracked other.txt"]);
  });
});

describe("a merge stopped on conflicts, discarded file by file", () => {
  before(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-conflicts-"));
    run("init", "-q");
    run("symbolic-ref", "HEAD", "refs/heads/main");
    write("gone.txt", "gone\n");
    write("m.txt", "m\n");
    run("add", "--all");
    run("commit", "-q", "--message", "base");
    run("switch", "-q", "-c", "feature");
    write("both.txt", "feature\n");
    write("gone.txt", "gone on feature\n");
    run("add", "--all");
    run("commit", "-q", "--message", "feature");
    run("switch", "-q", "main");
    write("both.txt", "main\n");
    run("rm", "-q", "gone.txt");
    run("add", "--all");
    run("commit", "-q", "--message", "main");
    assert.equal((await merge(cwd, "feature")).ok, false);
    write("m.txt", "m edited\n");
  });

  it("can't tell from the status which conflicts HEAD has, so asks HEAD", async () => {
    // Added on both sides (AA), and deleted by us (DU).
    assert.deepEqual(await changed(), ["conflicted both.txt", "conflicted gone.txt", "modified m.txt"]);
    assert.deepEqual(await readHeadPaths(cwd, ["both.txt", "gone.txt"]), ["both.txt"]);
  });

  it("is refused whole when a conflict HEAD lacks is restored from HEAD", async () => {
    const refused = await discard(cwd, { restore: ["both.txt", "gone.txt", "m.txt"], drop: [] });
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? "", /gone\.txt' is unmerged/);
    assert.equal(fs.readFileSync(path.join(cwd, "m.txt"), "utf8"), "m edited\n");
  });

  it("resets each conflict to HEAD, trashes the one HEAD lacks, and leaves the merge in progress", async () => {
    // What Repository.discard does: the conflict HEAD lacks goes to the trash first.
    const trash = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-trash-"));
    fs.renameSync(path.join(cwd, "gone.txt"), path.join(trash, "gone.txt"));
    assert.deepEqual(await discard(cwd, { restore: ["both.txt", "m.txt"], drop: ["gone.txt"] }), { ok: true });
    assert.deepEqual(await changed(), []);
    assert.equal(fs.readFileSync(path.join(cwd, "both.txt"), "utf8"), "main\n");
    assert.equal(fs.readFileSync(path.join(cwd, "m.txt"), "utf8"), "m\n");
    assert.equal(fs.existsSync(path.join(cwd, "gone.txt")), false);
    assert.equal(fs.readFileSync(path.join(trash, "gone.txt"), "utf8"), "gone on feature\n");
    assert.equal((await readState(cwd)).operation, "merge");
  });
});

describe("a network command's ssh", () => {
  it("follows a core.sshCommand set after an earlier network command", async (t) => {
    const inherited = { GIT_SSH: process.env.GIT_SSH, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND };
    delete process.env.GIT_SSH;
    delete process.env.GIT_SSH_COMMAND;
    // Not Object.assign: process.env would take an unset one as the string "undefined".
    t.after(() => Object.entries(inherited).forEach(([key, value]) => value !== undefined && (process.env[key] = value)));
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tet-bare-ssh-"));
    git(bare, "init", "-q", "--bare");
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-ssh-"));
    run("init", "-q");
    run("remote", "add", "origin", bare);
    // Without core.sshCommand, over no ssh at all.
    assert.deepEqual(await fetch(cwd), { ok: true });
    // Set later, the way a user does in a terminal: the ssh must be theirs, not tet's.
    const marker = path.join(cwd, "ssh-ran").replace(/\\/g, "/");
    const node = process.execPath.replace(/\\/g, "/");
    run("config", "core.sshCommand", `'${node}' -e "require('fs').writeFileSync(process.argv[1], '')" '${marker}'`);
    run("remote", "set-url", "origin", "ssh://tet.invalid/repo.git");
    assert.equal((await fetch(cwd)).ok, false);
    assert.ok(fs.existsSync(marker), "core.sshCommand ran");
  });
});

describe("remotes the tree has to read carefully", () => {
  it("names the branch of a clone of an empty repository, not its whole header", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tet-bare-empty-"));
    assert.equal(spawnSync("git", ["init", "-q", "--bare", bare]).status, 0);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-clone-"));
    run("clone", "-q", bare, ".");
    run("symbolic-ref", "HEAD", "refs/heads/main");
    run("config", "branch.main.remote", "origin");
    run("config", "branch.main.merge", "refs/heads/main");
    // The header reads "No commits yet on main...origin/main [gone]".
    const state = await readState(cwd, ["origin"]);
    assert.equal(state.head, "main");
    assert.equal(state.upstream, undefined);
  });

  it("keeps a remote whose name holds a slash as one remote", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tet-bare-fork-"));
    assert.equal(spawnSync("git", ["init", "-q", "--bare", bare]).status, 0);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-fork-"));
    run("init", "-q");
    run("symbolic-ref", "HEAD", "refs/heads/main");
    write("a.txt", "a\n");
    assert.deepEqual(await commitAll(cwd, "base"), { ok: true });
    run("remote", "add", "team/fork", bare);
    assert.deepEqual(await push(cwd, "team/fork", "main", undefined), { ok: true });
    run("remote", "set-head", "team/fork", "main");
    const state = await readState(cwd, ["team/fork"]);
    assert.deepEqual(state.remotes, [{ name: "team/fork", branches: ["main"] }]);
    assert.deepEqual(state.defaultBranch, { name: "main" });
    assert.equal(state.upstream, "team/fork/main");
    assert.deepEqual(state.branchUpstreams, { main: { remote: "team/fork", branch: "main" } });
  });
});

describe("a remote shared with another clone, as GitHub Desktop handles it", () => {
  let bare: string;
  let other: string;

  /** A commit in the other clone, pushed. */
  const pushFromOther = (name: string): void => {
    fs.writeFileSync(path.join(other, name), `${name}\n`);
    git(other, "add", name);
    git(other, "commit", "-q", "-m", name);
    git(other, "push", "-q");
  };

  before(() => {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "tet-bare-shared-"));
    git(bare, "init", "-q", "--bare", "--initial-branch=main");
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-shared-"));
    run("clone", "-q", bare, ".");
    run("symbolic-ref", "HEAD", "refs/heads/main");
    write("a.txt", "a\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "base");
    run("push", "-q", "--set-upstream", "origin", "main");
    other = fs.mkdtempSync(path.join(os.tmpdir(), "tet-git-other-"));
    assert.equal(spawnSync("git", ["clone", "-q", bare, other]).status, 0);
  });

  it("finds the remote's HEAD branch again after it was set by hand", async () => {
    assert.equal((await readState(cwd, ["origin"])).defaultBranch, undefined, "a clone of an empty remote has no origin/HEAD");
    await updateRemoteHead(cwd, "origin");
    assert.deepEqual((await readState(cwd, ["origin"])).defaultBranch, { name: "main" });
  });

  it("names the local branch tracking the default branch, whatever it is called", async () => {
    run("branch", "-q", "--track", "trunk", "origin/main");
    run("branch", "-q", "-m", "main", "work");
    const state = await readState(cwd, ["origin"]);
    // Both track origin/main and neither is called main: the first one.
    assert.deepEqual(state.defaultBranch, { name: "trunk" });
    run("branch", "-q", "-m", "work", "main");
    assert.deepEqual((await readState(cwd, ["origin"])).defaultBranch, { name: "main" }, "the one of that name wins");
    run("branch", "-q", "-D", "trunk");
  });

  it("pulls into a diverged branch as a merge while pull.ff is unset", async () => {
    pushFromOther("theirs.txt");
    write("ours.txt", "ours\n");
    assert.deepEqual(await commitAll(cwd, "ours"), { ok: true });
    assert.deepEqual(await pull(cwd), { ok: true });
    const state = await readState(cwd, ["origin"]);
    assert.deepEqual([state.ahead, state.behind], [2, 0]);
    assert.ok(fs.existsSync(path.join(cwd, "theirs.txt")));
  });

  it("pushes to an upstream of another name, whatever push.default says", async () => {
    run("switch", "-q", "--create", "local-name");
    run("push", "-q", "origin", "local-name:remote-name");
    run("branch", "-q", "--set-upstream-to=origin/remote-name");
    run("config", "push.default", "simple");
    write("d.txt", "d\n");
    assert.deepEqual(await commitAll(cwd, "d"), { ok: true });
    const upstream = (await readState(cwd, ["origin"])).branchUpstreams["local-name"];
    assert.deepEqual(upstream, { remote: "origin", branch: "remote-name" });
    assert.deepEqual(await push(cwd, upstream.remote, "local-name", upstream.branch), { ok: true });
    assert.equal(run("rev-parse", "origin/remote-name"), run("rev-parse", "HEAD"));
    run("switch", "-q", "main");
  });

  it("moves branches only behind their upstream after a fetch, and leaves the checked-out one", async () => {
    run("push", "-q", "origin", "main");
    run("branch", "-q", "--track", "behind", "origin/main");
    run("switch", "-q", "--create", "diverged", "--track", "origin/main");
    write("e.txt", "e\n");
    assert.deepEqual(await commitAll(cwd, "e"), { ok: true });
    run("switch", "-q", "main");
    const before = run("rev-parse", "main");
    git(other, "pull", "-q");
    pushFromOther("f.txt");
    assert.deepEqual(await fetch(cwd), { ok: true });
    const divergedBefore = run("rev-parse", "diverged");
    await fastForwardBranches(cwd);
    assert.equal(run("rev-parse", "behind"), run("rev-parse", "origin/main"));
    assert.equal(run("rev-parse", "diverged"), divergedBefore, "a diverged branch is not moved");
    assert.equal(run("rev-parse", "main"), before, "the checked-out branch is not moved");
    run("branch", "-q", "-D", "behind", "diverged");
  });

  it("warns before rebasing commits the upstream has, and not onto what it already has", async () => {
    run("merge", "-q", "--no-edit", "origin/main");
    run("push", "-q", "origin", "main");
    run("switch", "-q", "--create", "older", "HEAD~2");
    run("switch", "-q", "main");
    assert.equal(await rebaseRewritesPushed(cwd, "older"), true);
    assert.equal(await rebaseRewritesPushed(cwd, "origin/main"), false);
    run("branch", "-q", "-D", "older");
  });

  it("renames a branch by case alone, and never over a branch of exactly that name", async () => {
    run("branch", "-q", "casing");
    assert.deepEqual(await renameBranch(cwd, "casing", "Casing"), { ok: true });
    assert.equal(run("for-each-ref", "--format=%(refname)", "refs/heads/Casing"), "refs/heads/Casing");
    run("branch", "-q", "-D", "Casing");
  });

  it("forgets a remote branch someone else already deleted", async () => {
    run("push", "-q", "origin", "main:gone");
    run("fetch", "-q");
    git(other, "push", "-q", "origin", "--delete", "gone");
    assert.deepEqual(await deleteRemoteBranch(cwd, "origin", "gone"), { ok: true });
    assert.equal((await readState(cwd, ["origin"])).remotes[0]?.branches.includes("gone"), false);
  });
});

describe("a clone with an account's token", () => {
  it("answers git's questions from a script in the folder it is given", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tet-askpass-test-")), "askpass");
    const askpass = await ensureAskpass(dir);
    assert.equal(path.dirname(askpass), dir);
    // git asks the script for what no helper answers, the way a clone over https does.
    const fill = spawnSync("git", ["-c", "credential.helper=", "credential", "fill"], {
      input: "protocol=https\nhost=example.invalid\n\n",
      encoding: "utf8",
      env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", TET_ASKPASS_USER: "user", TET_ASKPASS_TOKEN: "token" }
    });
    assert.equal(fill.status, 0, fill.stderr);
    assert.match(fill.stdout, /^username=user$/m);
    assert.match(fill.stdout, /^password=token$/m);
  });
});
