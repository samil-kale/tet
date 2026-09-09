import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  addExclude,
  addFolder,
  readCommands,
  readExplorerView,
  readSbxConfig,
  removeFolder,
  writeCommands,
  writeSbxConfig
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
  it("reads a missing file or a file with no commands as an empty list", async () => {
    assert.deepEqual(await readCommands(root), []);
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

describe("readSbxConfig", () => {
  it("is disabled and empty for a project with no tet.json at all", async () => {
    assert.deepEqual(await readSbxConfig(root), {
      enabled: false,
      knowledge: { skills: false, plugins: false, instructions: false },
      ports: [],
      paths: []
    });
  });

  it("round-trips what writeSbxConfig wrote, keeping a saved command and another OS's paths alongside it", async () => {
    const otherOs = process.platform === "win32" ? "linux" : "win32";
    const theirs = { path: "/their/data", access: "Read", os: otherOs };
    const stale = [
      { path: "~/stale", access: "Read" },
      { path: "/stale/absolute", access: "Read", os: process.platform }
    ];
    put(JSON.stringify({ commands: ["keep"], sbx: { enabled: false, ports: [], paths: [theirs, ...stale] } }));
    const elsewhere = path.join(path.parse(os.homedir()).root, "elsewhere");
    const config = {
      enabled: true,
      knowledge: { skills: "Read+Write" as const, plugins: false as const, instructions: "Read" as const },
      ports: [{ host: "3000", container: "3000" }],
      paths: [
        { path: "~/data", access: "Read+Write" as const },
        { path: elsewhere, access: "Read" as const },
        // A single file is a row like any other — sbx mounts a file and a folder the same way.
        { path: "~/.npmrc", access: "Read" as const }
      ]
    };
    await writeSbxConfig(root, config);
    assert.deepEqual(await readSbxConfig(root), config, "the rows that apply here come back, the other OS's does not");
    const file = stored() as { commands: unknown; sbx: { knowledge: unknown; paths: unknown } };
    assert.deepEqual(
      file.sbx.knowledge,
      { skills: "rw", plugins: false, instructions: "r" },
      "knowledge is written alongside enabled, as sbx's own r/rw codes"
    );
    assert.deepEqual(file.commands, ["keep"], "the saved command survives");
    assert.deepEqual(
      file.sbx.paths,
      [
        theirs,
        { path: "~/data", access: "Read+Write" },
        { path: elsewhere, access: "Read", os: process.platform },
        { path: "~/.npmrc", access: "Read" }
      ],
      "the other OS's row survives; a ~ row is everyone's, an absolute one this platform's; the stale ones are replaced"
    );
  });

  it("drops a malformed row rather than throwing, and never carries a token", async () => {
    put(
      JSON.stringify({
        sbx: {
          enabled: true,
          knowledge: { skills: "not-a-real-access", plugins: true, instructions: "r" },
          ports: [{ host: "3000" }, { host: "3000", container: "3000" }],
          paths: [
            { path: "", os: process.platform },
            { path: "~/data", access: "not-a-real-access", os: process.platform },
            { path: "/elsewhere", access: "Read", os: process.platform === "win32" ? "linux" : "win32" }
          ],
          tokens: { claude: "sk-ant-should-not-be-read" }
        }
      })
    );
    assert.deepEqual(await readSbxConfig(root), {
      enabled: true,
      knowledge: { skills: false, plugins: false, instructions: "Read" },
      ports: [{ host: "3000", container: "3000" }],
      paths: [{ path: "~/data", access: "Read+Write" }]
    });
  });
});
