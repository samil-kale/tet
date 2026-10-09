import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeAfterChange, activeAtStart, rememberActive } from "../../src/renderer/lanes/projects/active-ref";
import { graphRefColors, layoutGraph, nodeLane, type GraphColor } from "../../src/renderer/lanes/git/graph-layout";
import { EMPTY_REPOSITORY_STATE } from "../../src/shared/types/git";
import type { GraphCommit } from "../../src/shared/types/git";
import type { Project } from "../../src/shared/types/project";
import { fakeLocalStorage } from "../helpers";

const main: Project = { id: "main", path: "/repo", name: "repo", worktrees: [{ path: "/wt/feature", branch: "feature", key: "k1" }] };
const other: Project = { id: "other", path: "/other", name: "other", worktrees: [] };
/** A worktree of `main` TET made. */
const worktree = { projectId: "main", worktree: "k1" };
const worktreeKey = "main-k1";

describe("the active repository or worktree after the list changed", () => {
  it("gives a deleted worktree's place to its project's repository, not the first", () => {
    assert.equal(activeAfterChange(worktreeKey, [other, main], [worktree], undefined), "main");
  });

  it("gives a removed project's place to the first", () => {
    assert.equal(activeAfterChange("main", [other], [{ projectId: "main" }, worktree], undefined), "other");
    assert.equal(activeAfterChange("other", [], [{ projectId: "other" }], undefined), null);
  });

  it("makes what the user just opened active", () => {
    assert.equal(activeAfterChange("main", [main], [], worktree), worktreeKey);
    assert.equal(activeAfterChange(null, [main], undefined, { projectId: "main" }), "main");
  });

  it("leaves the active one alone when one out of sight is removed", () => {
    assert.equal(activeAfterChange("other", [other, main], [worktree], undefined), "other");
  });
});

describe("the active repository or worktree at startup", () => {
  fakeLocalStorage();

  it("is the one active when TET last closed, while it is still open", () => {
    assert.equal(activeAtStart([other, main]), "other", "none remembered: the first");
    rememberActive("main");
    assert.equal(activeAtStart([other, main]), "main");
    rememberActive(worktreeKey);
    assert.equal(activeAtStart([other, main]), worktreeKey, "a worktree too");
    rememberActive(null);
    assert.equal(activeAtStart([other, main]), worktreeKey, "nothing active forgets nothing");
    assert.equal(activeAtStart([other]), "other", "closed since: the first project");
    assert.equal(activeAtStart([]), null);
  });
});

describe("the GRAPH's lanes", () => {
  const commit = (sha: string, parents: string[] = [], refs: GraphCommit["refs"] = []): GraphCommit => ({
    sha,
    parents,
    subject: sha,
    author: "a",
    date: 0,
    refs,
  });
  const ids = (lanes: { id: string }[]): string[] => lanes.map((lane) => lane.id);
  const none = new Map<string, GraphColor>();

  it("keeps a line of commits in one lane", () => {
    const rows = layoutGraph([commit("c", ["b"]), commit("b", ["a"]), commit("a")], none);
    assert.deepEqual(rows.map(nodeLane), [0, 0, 0]);
    assert.deepEqual(
      rows.map((row) => ids(row.output)),
      [["b"], ["a"], []],
    );
    assert.deepEqual(rows[1].input, rows[0].output, "a row starts with what the one above left");
  });

  it("opens a lane for a merge's second parent, and the lanes meet at the commit they wait for", () => {
    const rows = layoutGraph([commit("m", ["a2", "b"]), commit("a2", ["a"]), commit("b", ["a"]), commit("a")], none);
    assert.deepEqual(ids(rows[0].output), ["a2", "b"]);
    assert.deepEqual(ids(rows[2].output), ["a", "a"]);
    assert.deepEqual(ids(rows[3].input), ["a", "a"]);
    assert.equal(nodeLane(rows[3]), 0, "the first of them is the node's, the other bends in");
    assert.deepEqual(rows[3].output, []);
  });

  it("shifts the lanes right of an ended one to the left", () => {
    const rows = layoutGraph([commit("x", ["a"]), commit("y", ["b"]), commit("a"), commit("b")], none);
    assert.deepEqual(ids(rows[2].input), ["a", "b"]);
    assert.deepEqual(ids(rows[2].output), ["b"]);
  });

  it("puts a commit no lane waits for in a new lane at the right", () => {
    const rows = layoutGraph([commit("x", ["a"]), commit("y", ["b"])], none);
    assert.equal(nodeLane(rows[1]), 1);
  });

  it("colors a lane by the ref at its commit, else by the next of the repeating colors", () => {
    const colors = new Map([["local:main", "historyItemRefColor" as const]]);
    const rows = layoutGraph([commit("m", ["a", "b"], [{ name: "main", kind: "local" }]), commit("a"), commit("b")], colors);
    assert.deepEqual(
      rows[0].output.map((lane) => lane.color),
      ["historyItemRefColor", "foreground1"],
    );
  });

  it("colors the current branch, its upstream and the default branch", () => {
    const state = {
      ...EMPTY_REPOSITORY_STATE,
      head: "feature",
      upstream: "origin/feature",
      defaultBranch: { name: "develop", remote: "origin" },
    };
    assert.deepEqual(
      [...graphRefColors(state)],
      [
        ["remote:origin/develop", "historyItemBaseRefColor"],
        ["remote:origin/feature", "historyItemRemoteRefColor"],
        ["local:feature", "historyItemRefColor"],
      ],
    );
    assert.equal(graphRefColors({ ...state, detached: true }).has("local:feature"), false, "a detached HEAD is no branch");
  });
});
