import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeAfterChange, activeAtStart, rememberActive } from "../src/renderer/sidebar/active-project";
import type { Project } from "../src/shared/types";

const main: Project = { id: "main", path: "/repo", name: "repo", worktrees: [{ path: "/wt/feature", branch: "feature", key: "k1" }] };
const other: Project = { id: "other", path: "/other", name: "other", worktrees: [] };
/** A worktree of `main` TET made. */
const worktree = { projectId: "main", worktree: "k1" };
const worktreeKey = "main-k1";

describe("the repository or worktree in front after the list changed", () => {
  it("gives a deleted worktree's place to its project's repository, not the first", () => {
    assert.equal(activeAfterChange(worktreeKey, [other, main], [worktree], undefined), "main");
  });

  it("gives a removed project's place to the first", () => {
    assert.equal(activeAfterChange("main", [other], [{ projectId: "main" }, worktree], undefined), "other");
    assert.equal(activeAfterChange("other", [], [{ projectId: "other" }], undefined), null);
  });

  it("brings what the user just opened to the front", () => {
    assert.equal(activeAfterChange("main", [main], [], worktree), worktreeKey);
    assert.equal(activeAfterChange(null, [main], undefined, { projectId: "main" }), "main");
  });

  it("leaves the front alone when one out of sight is removed", () => {
    assert.equal(activeAfterChange("other", [other, main], [worktree], undefined), "other");
  });
});

describe("the repository or worktree in front at startup", () => {
  const storage = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value)
  };

  it("is the one in front when tet last closed, while it is still open", () => {
    assert.equal(activeAtStart([other, main]), "other", "none remembered: the first");
    rememberActive("main");
    assert.equal(activeAtStart([other, main]), "main");
    rememberActive(worktreeKey);
    assert.equal(activeAtStart([other, main]), worktreeKey, "a worktree too");
    rememberActive(null);
    assert.equal(activeAtStart([other, main]), worktreeKey, "nothing in front forgets nothing");
    assert.equal(activeAtStart([other]), "other", "closed since: the first project");
    assert.equal(activeAtStart([]), null);
  });
});
