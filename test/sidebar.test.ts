import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeAfterChange } from "../src/renderer/sidebar/active-project";
import type { Project } from "../src/shared/types";

const main: Project = { id: "main", path: "/repo", name: "repo" };
const other: Project = { id: "other", path: "/other", name: "other" };
const worktree: Project = { id: "wt", path: "/wt/feature", name: "feature", mainPath: "/repo" };
/** The worktree reopened under a new id, renamed or after a failed delete. */
const reopened: Project = { id: "wt2", path: "/wt/renamed", name: "renamed", mainPath: "/repo" };

describe("the project in front after the list changed", () => {
  const before = [other, main, worktree];

  it("gives a deleted worktree's place to its main project, not the first", () => {
    assert.equal(activeAfterChange("wt", before, [other, main], undefined, "wt"), "main");
  });

  it("gives any other removed project's place to the first", () => {
    assert.equal(activeAfterChange("main", [other, main], [other], undefined, "main"), "other");
    assert.equal(activeAfterChange("other", [other], [], undefined, "other"), null);
  });

  it("keeps the project in front when a worktree out of sight is renamed", () => {
    assert.equal(activeAfterChange("main", before, [other, main, reopened], "wt2", "wt"), "main");
  });

  it("follows the worktree in front to its new id", () => {
    assert.equal(activeAfterChange("wt", before, [other, main, reopened], "wt2", "wt"), "wt2");
  });

  it("brings a project added on its own to the front", () => {
    assert.equal(activeAfterChange("main", [main], [main, worktree], "wt", undefined), "wt");
    assert.equal(activeAfterChange(null, [], [main], "main", undefined), "main");
  });

  it("leaves the front alone when a project out of sight is removed", () => {
    assert.equal(activeAfterChange("main", before, [other, main], undefined, "wt"), "main");
  });
});
