import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { MAX_EDIT_BYTES, searchFiles, walkExplorer, type WalkView } from "../../src/main/git/explorer-read";
import type { FileSearchQuery, FileSearchResult } from "../../src/shared/types/files";
import { tempDir } from "../helpers";

/** git/explorer-read.ts: what the Explorer lists and its search reads off the disk. */

const NO_VIEW: WalkView = { folders: [], exclude: [] };

/** A folder holding `files` (path → content), directories made as needed; an `/`-ended key is an empty directory. */
function tree(files: Record<string, string>): string {
  const root = tempDir("tet-explorer-read-");
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    if (relative.endsWith("/")) {
      fs.mkdirSync(absolute, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
  }
  return root;
}

describe("the Explorer's walk", () => {
  it("lists files and empty folders sorted, and never the .git folder", async () => {
    const root = tree({ "b.txt": "", "a/z.txt": "", "a/y.txt": "", "empty/": "", ".git/HEAD": "ref", "a/inner/": "" });
    const walked = await walkExplorer(root, NO_VIEW, [], false);
    assert.deepEqual(walked.files, ["a/y.txt", "a/z.txt", "b.txt"]);
    assert.deepEqual(walked.emptyDirs, ["a/inner", "empty"]);
    assert.equal(walked.mtimes, undefined, "no stat is spent unless the sort asks for it");
  });

  it("leaves out what git ignores, files and folders, and what an exclude glob names", async () => {
    const root = tree({ "keep.ts": "", "out/built.js": "", "notes.log": "", "src/a.ts": "", "src/gen/x.ts": "", "src/old.min.js": "" });
    const walked = await walkExplorer(root, { folders: [], exclude: ["**/gen", "**/*.min.js"] }, ["out/", "notes.log"], false);
    assert.deepEqual(walked.files, ["keep.ts", "src/a.ts"]);
  });

  it("walks only the folders of the view, the outermost of two nested ones, and the root for a path of ''", async () => {
    const root = tree({ "a/one.txt": "", "a/b/two.txt": "", "c/three.txt": "", "top.txt": "" });
    const folders = (...paths: string[]): WalkView => ({ folders: paths.map((p) => ({ name: p, path: p })), exclude: [] });
    assert.deepEqual((await walkExplorer(root, folders("a", "a/b"), [], false)).files, ["a/b/two.txt", "a/one.txt"]);
    assert.deepEqual((await walkExplorer(root, folders("a", "c"), [], false)).files, ["a/b/two.txt", "a/one.txt", "c/three.txt"]);
    assert.equal((await walkExplorer(root, folders("", "a"), [], false)).files.length, 4);
  });

  it("lists a link as a file and never follows it, so a cycle ends", async (t) => {
    const root = tree({ "real/file.txt": "" });
    try {
      fs.symlinkSync(root, path.join(root, "real", "loop"), "dir");
    } catch {
      t.skip("symbolic links need a privilege this machine does not give");
      return;
    }
    const walked = await walkExplorer(root, NO_VIEW, [], false);
    assert.deepEqual(walked.files, ["real/file.txt", "real/loop"]);
  });

  it("reads the modification times only where asked", async () => {
    const root = tree({ "a.txt": "", "d/b.txt": "" });
    const walked = await walkExplorer(root, NO_VIEW, [], true);
    assert.deepEqual(Object.keys(walked.mtimes ?? {}).sort(), ["a.txt", "d", "d/b.txt"]);
    assert.equal(walked.mtimes?.["a.txt"], fs.statSync(path.join(root, "a.txt")).mtimeMs);
  });

  it("lists nothing for a folder that is gone", async () => {
    const walked = await walkExplorer(path.join(tempDir("tet-explorer-read-"), "gone"), NO_VIEW, [], false);
    assert.deepEqual(walked, { files: [], emptyDirs: [], mtimes: undefined });
  });
});

describe("the Explorer's search", () => {
  const query = (text: string, flags: Partial<FileSearchQuery> = {}): FileSearchQuery => ({
    text,
    matchCase: false,
    wholeWord: false,
    regex: false,
    ...flags,
  });
  const run = (
    root: string,
    q: FileSearchQuery,
    ignored: string[] = [],
    signal = new AbortController().signal,
  ): Promise<FileSearchResult> => searchFiles(root, NO_VIEW, ignored, q, signal);
  const where = (result: FileSearchResult): string[] =>
    result.files.flatMap((file) => file.matches.map((match) => `${file.path}:${match.line}:${match.column}:${match.length}`));

  it("is case-insensitive unless asked, takes a query literally unless it is a regex, and counts every match in a line", async () => {
    const root = tree({ "a.txt": "Foo foo.bar FOO\nf.o\n" });
    assert.deepEqual(where(await run(root, query("foo"))), ["a.txt:1:1:3", "a.txt:1:5:3", "a.txt:1:13:3"]);
    assert.deepEqual(where(await run(root, query("foo", { matchCase: true }))), ["a.txt:1:5:3"]);
    assert.deepEqual(where(await run(root, query("f.o"))), ["a.txt:2:1:3"], "the dot is a dot");
    assert.deepEqual(where(await run(root, query("f.o", { regex: true }))), ["a.txt:1:1:3", "a.txt:1:5:3", "a.txt:1:13:3", "a.txt:2:1:3"]);
  });

  it("matches a whole word between word boundaries, a regex included", async () => {
    const root = tree({ "a.txt": "cat concat cat_ cat\n" });
    assert.deepEqual(where(await run(root, query("cat", { wholeWord: true }))), ["a.txt:1:1:3", "a.txt:1:17:3"]);
    assert.deepEqual(where(await run(root, query("c.t", { wholeWord: true, regex: true }))), ["a.txt:1:1:3", "a.txt:1:17:3"]);
  });

  it("answers an invalid regex as the result's error and reads nothing", async () => {
    const result = await run(tree({ "a.txt": "x\n" }), query("(", { regex: true }));
    assert.deepEqual([result.files, result.truncated], [[], false]);
    assert.match(result.error ?? "", /./);
  });

  it("skips what git ignores, a binary file and one too large to open in the editor", async () => {
    const root = tree({ "a.txt": "needle\n", "out/b.txt": "needle\n" });
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x6e, 0, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    fs.writeFileSync(path.join(root, "huge.txt"), `needle${"x".repeat(MAX_EDIT_BYTES)}`);
    assert.deepEqual(where(await run(root, query("needle"), ["out/"])), ["a.txt:1:1:6"]);
  });

  it("goes past a pattern that can match nothing, and reads CRLF lines without their return", async () => {
    const root = tree({ "a.txt": "ab\r\naab\r\n" });
    const result = await run(root, query("a*", { regex: true }));
    assert.deepEqual(where(result), ["a.txt:1:1:1", "a.txt:2:1:2"]);
    assert.equal(result.files[0].matches[1].text, "aab");
  });

  it("keeps a long line's match in view, a window around it", async () => {
    const line = `${"x".repeat(300)}needle${"y".repeat(500)}`;
    const [match] = (await run(tree({ "a.txt": `${line}\n` }), query("needle"))).files[0].matches;
    assert.equal(match.column, 301);
    assert.ok(match.text.length <= 400);
    assert.equal(match.text.slice(match.textColumn, match.textColumn + match.length), "needle");
  });

  it("stops at the cap and says the list is a part of what is there", async () => {
    const root = tree({ "a.txt": "x\n".repeat(1500), "b.txt": "x\n".repeat(1500) });
    const result = await run(root, query("x"));
    assert.equal(result.truncated, true);
    assert.equal(
      result.files.reduce((count, file) => count + file.matches.length, 0),
      2000,
    );
  });

  it("gives up once the next search was asked for", async () => {
    const root = tree({ "a.txt": "needle\n", "b.txt": "needle\n" });
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await run(root, query("needle"), [], controller.signal), { files: [], truncated: false });
  });
});
