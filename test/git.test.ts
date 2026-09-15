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
  discard,
  ignorePath,
  isRepository,
  listIgnored,
  merge,
  push,
  readCommitContext,
  readHeadBlob,
  readState,
  resolveRoot,
  stashDrop,
  stashPush
} from "../src/main/git/git";

/**
 * git.ts against the real git, in a repository built up step by step. It imports nothing from
 * electron, so it runs in this process.
 */

// Without the machine's config: a signing key or a hook there would turn a commit into a question.
const identity = {
  GIT_AUTHOR_NAME: "tet test",
  GIT_AUTHOR_EMAIL: "test@tet.invalid",
  GIT_COMMITTER_NAME: "tet test",
  GIT_COMMITTER_EMAIL: "test@tet.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), "tet-git-noglobal")
};
Object.assign(process.env, identity);
fs.writeFileSync(identity.GIT_CONFIG_GLOBAL, "");

let cwd: string;

function run(...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const write = (name: string, content: string): void => fs.writeFileSync(path.join(cwd, name), content);

/** The editor tab's read cap; `readHeadBlob` takes it per call. */
const MAX_BYTES = 4 * 1024 * 1024;
const head = (name: string, origPath?: string) => readHeadBlob(cwd, name, { origPath, maxBytes: MAX_BYTES });

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
    assert.deepEqual(await createBranch(cwd, "feature", "main"), { ok: true });
    const state = await readState(cwd);
    assert.equal(state.head, "feature");
    assert.deepEqual(state.localBranches, ["feature", "main"]);
    assert.deepEqual(state.tags, ["v1"]);
  });

  it("stashes the changes and lists the stash by the ref the commands take", async () => {
    write("b.txt", "changed\n");
    assert.deepEqual(await stashPush(cwd, "wip"), { ok: true });
    const state = await readState(cwd);
    assert.deepEqual(state.changes, []);
    assert.equal(state.stashes.length, 1);
    assert.equal(state.stashes[0].ref, "stash@{0}");
    assert.match(state.stashes[0].message, /wip/);
    assert.deepEqual(await stashDrop(cwd, "stash@{0}"), { ok: true });
    assert.deepEqual((await readState(cwd)).stashes, []);
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
    assert.deepEqual(await push(cwd, "origin", "main", true), { ok: true });
    run("remote", "set-head", "origin", "main");
    let state = await readState(cwd);
    assert.equal(state.upstream, "origin/main");
    assert.deepEqual([state.ahead, state.behind], [0, 0]);
    assert.deepEqual(state.remotes, [{ name: "origin", branches: ["main"] }]);
    assert.equal(state.defaultBranch, "main");
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
  const changed = async (): Promise<string[]> =>
    (await readState(cwd)).changes.map((change) => `${change.status} ${change.path}`).sort();

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
    assert.deepEqual(await push(cwd, "team/fork", "main", true), { ok: true });
    run("remote", "set-head", "team/fork", "main");
    const state = await readState(cwd, ["team/fork"]);
    assert.deepEqual(state.remotes, [{ name: "team/fork", branches: ["main"] }]);
    assert.equal(state.defaultBranch, "main");
    assert.equal(state.upstream, "team/fork/main");
  });
});
