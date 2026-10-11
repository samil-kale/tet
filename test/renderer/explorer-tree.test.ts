import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ancestorsOf, buildForest, hasExpandedRootChild, rootIndexFor } from "../../src/renderer/lanes/files/explorer-tree";
import type { TreeNode } from "../../src/renderer/ui/tree";
import type { ExplorerListing } from "../../src/shared/types/files";

/** lanes/files/explorer-tree.ts: the Explorer's tree out of its listing. */

function listing(files: string[], extra: Partial<ExplorerListing> = {}): ExplorerListing {
  return { files, emptyDirs: [], compactFolders: false, sortOrder: "default", ...extra };
}

/** The names of one level, in order. */
const names = (nodes: TreeNode[]): string[] => nodes.map((node) => node.name);

const FILES = ["b.ts", "a.md", "src/z.ts", "src/y.json", "docs/readme.md"];

describe("the Explorer's tree", () => {
  it("lists folders first, then files, each by name, by default and as foldersNestsFiles", () => {
    for (const sortOrder of ["default", "foldersNestsFiles"] as const) {
      const tree = buildForest(listing(FILES, { sortOrder }));
      assert.deepEqual(names(tree), ["docs", "src", "a.md", "b.ts"], sortOrder);
      assert.deepEqual(names(tree[1].children!), ["y.json", "z.ts"], sortOrder);
    }
  });

  it("sorts by name alone, folders among files, as mixed", () => {
    assert.deepEqual(names(buildForest(listing(FILES, { sortOrder: "mixed" }))), ["a.md", "b.ts", "docs", "src"]);
  });

  it("lists files before folders as filesFirst", () => {
    assert.deepEqual(names(buildForest(listing(FILES, { sortOrder: "filesFirst" }))), ["a.md", "b.ts", "docs", "src"]);
    assert.deepEqual(names(buildForest(listing(["z/x.ts", "a/y.ts", "m.ts"], { sortOrder: "filesFirst" }))), ["m.ts", "a", "z"]);
  });

  it("sorts files by extension, then name, and keeps folders first, as type", () => {
    const tree = buildForest(listing(["b.ts", "a.md", "c.ts", "d.json", "dir/x.ts"], { sortOrder: "type" }));
    assert.deepEqual(names(tree), ["dir", "d.json", "a.md", "b.ts", "c.ts"]);
  });

  it("lists the newest first, then by name, as modified; what has no time goes last", () => {
    const mtimes = { "old.ts": 10, "new.ts": 30, "mid.ts": 20 };
    const tree = buildForest(listing(["mid.ts", "none.ts", "old.ts", "new.ts"], { sortOrder: "modified", mtimes }));
    assert.deepEqual(names(tree), ["new.ts", "mid.ts", "old.ts", "none.ts"]);
  });

  it("keeps an empty folder, and a file's folders, in the tree", () => {
    const tree = buildForest(listing(["a/b/c.ts"], { emptyDirs: ["empty", "a/also-empty"] }));
    assert.deepEqual(names(tree), ["a", "empty"]);
    assert.deepEqual(names(tree[0].children!), ["also-empty", "b"]);
    assert.deepEqual(tree[1].children, []);
  });

  it("builds a subtree per `folders` entry, each a root node with ids of its own", () => {
    const tree = buildForest(
      listing(["src/a.ts", "src/lib/b.ts", "README.md"], {
        roots: [
          { name: "Everything", path: "" },
          { name: "Source", path: "src" },
        ],
      }),
    );
    assert.deepEqual(
      tree.map(({ id, name, path, root }) => ({ id, name, path, root })),
      [
        { id: "0:", name: "Everything", path: "", root: true },
        { id: "1:", name: "Source", path: "src", root: true },
      ],
    );
    // The same file under both roots, told apart by the root's index.
    assert.equal(tree[0].children![0].children![1].id, "0:src/a.ts");
    assert.deepEqual(
      tree[1].children!.map((node) => node.id),
      ["1:src/lib", "1:src/a.ts"],
    );
    assert.deepEqual(names(tree[1].children!), ["lib", "a.ts"]);
  });
});

describe("the root a file belongs to", () => {
  const roots = [
    { name: "All", path: "" },
    { name: "Src", path: "src" },
    { name: "Lib", path: "src/lib" },
  ];

  it("is the innermost one containing it", () => {
    assert.equal(rootIndexFor(roots, "src/lib/a.ts"), 2);
    assert.equal(rootIndexFor(roots, "src/a.ts"), 1);
    assert.equal(rootIndexFor(roots, "README.md"), 0);
  });

  it("is none where no root contains it, and a folder's name alone is not its folder", () => {
    assert.equal(rootIndexFor([{ name: "Src", path: "src" }], "README.md"), undefined);
    assert.equal(rootIndexFor([{ name: "Src", path: "src" }], "srcs/a.ts"), undefined);
    assert.equal(rootIndexFor([], "a.ts"), undefined);
  });
});

describe("a file's folders", () => {
  it("are listed outermost first", () => {
    assert.deepEqual(ancestorsOf("a/b/c.ts"), ["a", "a/b"]);
    assert.deepEqual(ancestorsOf("a/c.ts"), ["a"]);
  });

  it("are none for a file at the top", () => {
    assert.deepEqual(ancestorsOf("c.ts"), []);
  });
});

describe("a root with an open folder", () => {
  const roots = buildForest(listing(["src/a.ts", "top.ts"], { roots: [{ name: "All", path: "" }] }));

  it("is told by an expanded child folder under an expanded root", () => {
    assert.equal(hasExpandedRootChild(roots, { "0:src": true }), true);
  });

  it("is not told by a collapsed folder, a file, or a collapsed root", () => {
    assert.equal(hasExpandedRootChild(roots, {}), false);
    assert.equal(hasExpandedRootChild(roots, { "0:src": false }), false);
    assert.equal(hasExpandedRootChild(roots, { "0:top.ts": true }), false);
    assert.equal(hasExpandedRootChild(roots, { "0:": false, "0:src": true }), false);
  });
});
