import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import {
  abortOperation,
  commitAll,
  createBranch,
  createTag,
  discard,
  ignorePath,
  isRepository,
  listIgnored,
  merge,
  push,
  readDiff,
  readFileLines,
  readState,
  resolveRoot,
  stashDrop,
  stashPush
} from "../src/main/git/git";

/**
 * git.ts against the real git, in a repository built up step by step — every reading the git
 * pane makes of a working tree, in the order a working tree goes through them. The module runs
 * in its own process in the app (git-host.ts) and imports nothing from electron, so here it
 * runs in this one.
 */

// A repository of the test's own, with an identity of its own, and without the machine's
// config: a signing key or a hook there would turn a commit into a question.
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
  });

  it("shows a new file as untracked, with the file itself as its diff", async () => {
    write("a.txt", "one\ntwo\nthree\n");
    assert.deepEqual((await readState(cwd)).changes, [{ path: "a.txt", status: "untracked" }]);
    const diff = await readDiff(cwd, "a.txt", { untracked: true });
    assert.equal(diff.binary, false);
    assert.deepEqual(
      diff.lines.filter((entry) => entry.type === "add").map((entry) => entry.text),
      ["one", "two", "three"]
    );
  });

  it("commits everything and is clean again", async () => {
    assert.deepEqual(await commitAll(cwd, "first"), { ok: true });
    const state = await readState(cwd);
    assert.deepEqual(state.changes, []);
    assert.deepEqual(state.localBranches, ["main"]);
  });

  it("reads a modification as a unified diff with line numbers, and discards it", async () => {
    write("a.txt", "one\n2\nthree\n");
    assert.deepEqual((await readState(cwd)).changes, [{ path: "a.txt", status: "modified" }]);
    const diff = await readDiff(cwd, "a.txt", { untracked: false });
    const [hunk, ...rest] = diff.lines;
    assert.equal(hunk.type, "hunk");
    assert.deepEqual(
      rest.map((entry) => [entry.type, entry.oldLine, entry.newLine, entry.text]),
      [
        ["context", 1, 1, "one"],
        ["del", 2, undefined, "two"],
        ["add", undefined, 2, "2"],
        ["context", 3, 3, "three"]
      ]
    );
    assert.deepEqual(await discard(cwd, { restore: ["a.txt"], drop: [] }), { ok: true });
    assert.deepEqual(await readFileLines(cwd, "a.txt", 2, 2), ["two"]);
    assert.deepEqual((await readState(cwd)).changes, []);
  });

  it("reads a staged rename as one change with its old path", async () => {
    run("mv", "a.txt", "b.txt");
    assert.deepEqual((await readState(cwd)).changes, [{ path: "b.txt", status: "renamed", origPath: "a.txt" }]);
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
    // Against resolveRoot(cwd) itself, not fs.realpathSync(cwd): on a Windows runner whose
    // %TEMP% is an 8.3 short name, realpathSync doesn't expand it but git's own cwd resolution
    // does, so the two disagree on a path that still names the same directory.
    assert.equal(await resolveRoot(sub), await resolveRoot(cwd));
    assert.equal(await resolveRoot(os.tmpdir()), undefined);
  });
});
