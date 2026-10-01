import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdEscape } from "../../src/renderer/ui/use-escape";
import { buildTree, compactTree, compareGrouped, filesByNode, filterTree, foldersIn, sortTree, type TreeNode } from "../../src/renderer/ui/tree";

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
      "README.md"
    ]);
  });

  it("folds only-child folder chains into one row, never a root", () => {
    const root: TreeNode = { id: "", name: "Changes", path: "", children: buildTree(["a/b/c/x.ts"]), root: true };
    const [compacted] = compactTree([root]);
    assert.deepEqual(outline([compacted]), ["Changes", "  a/b/c", "    x.ts"]);
    assert.equal(compacted.children![0].path, "a/b/c");
  });

  it("keeps a matching file's folders, and a matching folder whole", () => {
    assert.deepEqual(outline(filterTree(buildTree(paths), "app")), ["src", "  renderer", "    App.tsx"]);
    assert.deepEqual(outline(filterTree(buildTree(paths), "src/main/git")), ["src", "  main", "    git", "      git.ts", "      repository.ts"]);
  });

  it("lists the files under every node, and every folder", () => {
    const files = filesByNode(buildTree(paths));
    assert.deepEqual(files.get("src")!.sort(), ["src/main/git/git.ts", "src/main/git/repository.ts", "src/renderer/App.tsx"]);
    assert.deepEqual(files.get("src/main/git/git.ts"), ["src/main/git/git.ts"]);
    assert.deepEqual(foldersIn(buildTree(paths)).sort(), ["src", "src/main", "src/main/git", "src/renderer"]);
  });
});
