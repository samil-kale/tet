import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  addExclude,
  addFolder,
  mergeCommands,
  readCommands,
  readExplorerView,
  removeFolder,
  writeCommands
} from "../src/main/git/commands";

/** tet.json: the user's file, read defensively and written back with nothing of theirs lost. */

let root: string;
const file = (): string => path.join(root, "tet.json");
const put = (content: string): void => fs.writeFileSync(file(), content);
const stored = (): unknown => JSON.parse(fs.readFileSync(file(), "utf8"));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tet-json-"));
});

describe("readCommands", () => {
  it("tells no file apart from a file with no commands", async () => {
    assert.equal(await readCommands(root), null);
    put("{}");
    assert.deepEqual(await readCommands(root), []);
    put('{"actions": ["old key"]}');
    assert.deepEqual(await readCommands(root), [], "the renamed key is not read");
  });

  it("takes both spellings and drops what is neither", async () => {
    put(
      JSON.stringify({
        commands: [
          "npm run build",
          "   ",
          { command: "npm test", name: " unit ", cwd: "web", env: { A: "1", B: 2 }, shell: true },
          { command: "", name: "empty" },
          { name: "no command" },
          42,
          null
        ]
      })
    );
    assert.deepEqual(await readCommands(root), [
      { command: "npm run build" },
      { command: "npm test", name: " unit ", cwd: "web", env: { A: "1" }, shell: true }
    ]);
  });

  it("reads a broken file as no commands, and refuses to write over it", async () => {
    put("{ not json");
    assert.deepEqual(await readCommands(root), []);
    await assert.rejects(writeCommands(root, [{ command: "x" }]), /not valid JSON/);
    assert.equal(fs.readFileSync(file(), "utf8"), "{ not json", "untouched");
  });
});

describe("writeCommands", () => {
  it("collapses to the short form and keeps every other key", async () => {
    put(JSON.stringify({ folders: [{ path: "src" }], other: true }));
    await writeCommands(root, [{ command: "a" }, { command: "b", cwd: "web" }, { command: "c", name: "see" }]);
    assert.deepEqual(stored(), {
      folders: [{ path: "src" }],
      other: true,
      commands: ["a", { command: "b", cwd: "web" }, { command: "c", name: "see" }]
    });
  });
});

describe("mergeCommands", () => {
  it("puts a new command behind the last one of the same tool, skipping what is there", () => {
    const existing = [{ command: "npm run build" }, { command: "mvn test" }, { command: "npm test" }];
    const merged = mergeCommands(existing, [
      { command: "npm test" },
      { command: "mvn package" },
      { command: "cargo run" },
      { command: "npm start" }
    ]);
    assert.deepEqual(
      merged.map((entry) => entry.command),
      ["npm run build", "mvn test", "mvn package", "npm test", "npm start", "cargo run"]
    );
  });
});

describe("readExplorerView", () => {
  it("is the whole repository with defaults when there is nothing to read", async () => {
    assert.deepEqual(await readExplorerView(root), {
      folders: [],
      exclude: [],
      excludeGitIgnore: false,
      compactFolders: true,
      sortOrder: "default"
    });
    put("[]");
    assert.deepEqual((await readExplorerView(root)).folders, []);
  });

  it("normalizes folders and skips what is not inside the repository", async () => {
    put(
      JSON.stringify({
        folders: [
          { path: "." },
          { path: "src\\main/", name: "  main " },
          "web",
          { path: "src/main" },
          { path: "/abs" },
          { path: "C:/abs" },
          { path: "../out" },
          { path: 3 },
          "x/../y"
        ]
      })
    );
    assert.deepEqual((await readExplorerView(root)).folders, [
      { path: "", name: path.basename(root) },
      { path: "src/main", name: "main" },
      { path: "web", name: "web" },
      { path: "y", name: "y" }
    ]);
  });

  it("reads the settings the way VS Code spells them, and only what is well-formed", async () => {
    put(
      JSON.stringify({
        settings: {
          "files.exclude": { "**/node_modules": true, dist: false, " ": true, "*.log": "yes" },
          "explorer.excludeGitIgnore": true,
          "explorer.compactFolders": false,
          "explorer.sortOrder": "modified"
        }
      })
    );
    assert.deepEqual(await readExplorerView(root), {
      folders: [],
      exclude: ["**/node_modules"],
      excludeGitIgnore: true,
      compactFolders: false,
      sortOrder: "modified"
    });
    put(JSON.stringify({ settings: { "explorer.sortOrder": "sideways", "explorer.compactFolders": "no" } }));
    const view = await readExplorerView(root);
    assert.equal(view.sortOrder, "default");
    assert.equal(view.compactFolders, true, "not false is on");
  });
});

describe("the tree's own edits", () => {
  it("writes the root down beside the first folder added, and drops the key with the last removed", async () => {
    put(JSON.stringify({ commands: ["keep"] }));
    await addFolder(root, "src");
    assert.deepEqual(stored(), { commands: ["keep"], folders: [{ path: "." }, { path: "src" }] });
    await addFolder(root, "src");
    assert.equal((stored() as { folders: unknown[] }).folders.length, 2, "not twice");
    await removeFolder(root, "src");
    assert.deepEqual(stored(), { commands: ["keep"], folders: [{ path: "." }] });
    // The tree keys the root as "", the way every repository-relative path is spelled there.
    await removeFolder(root, "");
    assert.deepEqual(stored(), { commands: ["keep"] });
  });

  it("excludes a path the way VS Code stores it, keeping the other patterns", async () => {
    put(JSON.stringify({ settings: { "files.exclude": { dist: true }, "explorer.sortOrder": "type" } }));
    await addExclude(root, "build/out");
    assert.deepEqual(stored(), {
      settings: { "files.exclude": { dist: true, "build/out": true }, "explorer.sortOrder": "type" }
    });
  });
});
