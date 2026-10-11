import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fakeLocalStorage } from "../helpers";
import { reorder } from "../../src/renderer/ui/drag-reorder";
import { layoutFlag, layoutKey } from "../../src/renderer/ui/layout-storage";
import { holdEscape } from "../../src/renderer/ui/use-escape";
import {
  buildTree,
  compactTree,
  compareGrouped,
  filesByNode,
  filterTree,
  foldersIn,
  sortTree,
  type TreeNode,
} from "../../src/renderer/ui/tree";

/** ui/: what the views share. */

describe("Escape over the window's dialogs", () => {
  it("closes only the last one opened, then the one below it", () => {
    // What the renderer's `document` does with a keydown, enough for the capture listener.
    const globals = globalThis as { document?: EventTarget };
    globals.document = new EventTarget();
    try {
      const closed: string[] = [];
      const escape = (): Event => Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
      const releaseSettings = holdEscape({ current: () => closed.push("settings") });
      const releaseCredential = holdEscape({ current: () => closed.push("credential") });
      globals.document.dispatchEvent(escape());
      assert.deepEqual(closed, ["credential"], "the credential dialog over the Settings");
      releaseCredential();
      globals.document.dispatchEvent(escape());
      assert.deepEqual(closed, ["credential", "settings"]);
      releaseSettings();
      globals.document.dispatchEvent(escape());
      assert.deepEqual(closed, ["credential", "settings"], "nothing left to close");
    } finally {
      delete globals.document;
    }
  });
});

/** The rows' names, a folder's children indented under it. */
function outline(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.name}`, ...outline(node.children ?? [], depth + 1)]);
}

describe("a tree of repository paths", () => {
  const paths = ["src/main/git/git.ts", "src/main/git/repository.ts", "README.md", "src/renderer/App.tsx"];

  it("nests files into folders, folders first", () => {
    const tree = buildTree(paths);
    sortTree(tree, (a, b) => compareGrouped(a, b, true));
    assert.deepEqual(outline(tree), [
      "src",
      "  main",
      "    git",
      "      git.ts",
      "      repository.ts",
      "  renderer",
      "    App.tsx",
      "README.md",
    ]);
  });

  it("compacts only-child folder chains into one row, never a root", () => {
    const root: TreeNode = { id: "", name: "Changes", path: "", children: buildTree(["a/b/c/x.ts"]), root: true };
    const [compacted] = compactTree([root]);
    assert.deepEqual(outline([compacted]), ["Changes", "  a/b/c", "    x.ts"]);
    assert.equal(compacted.children![0].path, "a/b/c");
  });

  it("keeps a matching file's folders, and a matching folder whole", () => {
    assert.deepEqual(outline(filterTree(buildTree(paths), "app")), ["src", "  renderer", "    App.tsx"]);
    assert.deepEqual(outline(filterTree(buildTree(paths), "src/main/git")), [
      "src",
      "  main",
      "    git",
      "      git.ts",
      "      repository.ts",
    ]);
  });

  it("lists the files under every node, and every folder", () => {
    const files = filesByNode(buildTree(paths));
    assert.deepEqual(files.get("src")!.sort(), ["src/main/git/git.ts", "src/main/git/repository.ts", "src/renderer/App.tsx"]);
    assert.deepEqual(files.get("src/main/git/git.ts"), ["src/main/git/git.ts"]);
    assert.deepEqual(foldersIn(buildTree(paths)).sort(), ["src", "src/main", "src/main/git", "src/renderer"]);
  });
});

describe("reordering a list", () => {
  const letters = ["a", "b", "c", "d"];

  it("moves a row forward to an insertion index, which counts the row itself", () => {
    assert.deepEqual(reorder(letters, 0, 3), ["b", "c", "a", "d"]);
    assert.deepEqual(reorder(letters, 0, 4), ["b", "c", "d", "a"]);
  });

  it("moves a row back", () => {
    assert.deepEqual(reorder(letters, 3, 0), ["d", "a", "b", "c"]);
    assert.deepEqual(reorder(letters, 2, 1), ["a", "c", "b", "d"]);
  });

  it("leaves the order where the row is dropped on or right behind itself", () => {
    assert.deepEqual(reorder(letters, 1, 1), letters);
    assert.deepEqual(reorder(letters, 1, 2), letters);
  });

  it("keeps every row once, and the list it was given", () => {
    const moved = reorder(letters, 1, 4);
    assert.deepEqual([...moved].sort(), letters);
    assert.deepEqual(letters, ["a", "b", "c", "d"]);
    assert.deepEqual(reorder(["only"], 0, 1), ["only"]);
  });
});

describe("the layout kept in the window's storage", () => {
  it("names a key under the layout prefix", () => {
    assert.equal(layoutKey("lane.git"), "tet.layout.lane.git");
  });

  it("reads a flag once, false unless stored as true, and writes through", () => {
    const storage = fakeLocalStorage();
    try {
      assert.equal(layoutFlag("alsoPush").get(), false);
      storage.set(layoutKey("alsoPush"), "true");
      const flag = layoutFlag("alsoPush");
      assert.equal(flag.get(), true);
      flag.set(false);
      assert.equal(flag.get(), false);
      assert.equal(storage.get(layoutKey("alsoPush")), "false");
      assert.equal(layoutFlag("alsoPush").get(), false, "what the next one opens with");
      storage.set(layoutKey("alsoPush"), "yes");
      assert.equal(layoutFlag("alsoPush").get(), false, "only `true` counts");
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
