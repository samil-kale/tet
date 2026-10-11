import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { createFileLinkProvider } from "../../src/renderer/tabs/links/file-links";
import { createUrlLinkProvider } from "../../src/renderer/tabs/links/url-links";
import { PLATFORM } from "../../src/renderer/platform";

/** tabs/links/: which text in a terminal's rows is a link, and where it lies. */

interface FakeRow {
  text: string;
  /** Soft-wrapped onto the row above (xterm's `isWrapped`). */
  wrapped?: boolean;
}

/** The part of xterm's buffer the providers read: rows of single-width cells, `cols` wide. */
function fakeTerminal(rows: FakeRow[], cols = 40): Terminal {
  const line = (row: FakeRow) => ({
    isWrapped: row.wrapped === true,
    length: cols,
    translateToString: (trimRight?: boolean) => (trimRight ? row.text.trimEnd() : row.text.padEnd(cols)),
    getCell: (index: number, cell: { chars: string; width: number }) => {
      cell.chars = row.text[index] ?? "";
      cell.width = 1;
    },
  });
  const active = {
    getLine: (index: number) => (rows[index] ? line(rows[index]) : undefined),
    getNullCell: () => ({
      chars: "",
      width: 1,
      getChars() {
        return this.chars;
      },
      getWidth() {
        return this.width;
      },
    }),
  };
  return { buffer: { active } } as unknown as Terminal;
}

function linksAt(provider: ILinkProvider, row: number): ILink[] {
  let found: ILink[] = [];
  provider.provideLinks(row, (links) => (found = links ?? []));
  return found;
}

/** The texts the file provider finds on the one row of `text`. */
function fileLinksIn(text: string): string[] {
  return linksAt(
    createFileLinkProvider(fakeTerminal([{ text }]), () => undefined),
    1,
  ).map((link) => link.text);
}

function urlLinksIn(text: string): string[] {
  return linksAt(
    createUrlLinkProvider(fakeTerminal([{ text }]), () => undefined),
    1,
  ).map((link) => link.text);
}

const HELD = { ctrlKey: PLATFORM.modifierKey === "Control", metaKey: PLATFORM.modifierKey === "Meta" } as MouseEvent;
const NOT_HELD = { ctrlKey: false, metaKey: false } as MouseEvent;

describe("file links", () => {
  it("finds a path with separators, relative, absolute or under home", () => {
    assert.deepEqual(fileLinksIn("error in src/main/main.ts now"), ["src/main/main.ts"]);
    assert.deepEqual(fileLinksIn("see ./foo/bar.ts"), ["./foo/bar.ts"]);
    assert.deepEqual(fileLinksIn("see ../up/file.json"), ["../up/file.json"]);
    assert.deepEqual(fileLinksIn(String.raw`opened C:\Users\x\file.txt ok`), [String.raw`C:\Users\x\file.txt`]);
    assert.deepEqual(fileLinksIn("config ~/.tet/settings.json"), ["~/.tet/settings.json"]);
  });

  it("finds a bare file name, and every one on a row", () => {
    assert.deepEqual(fileLinksIn("edited package.json and README.md"), ["package.json", "README.md"]);
  });

  it("leaves out what only looks like a file: abbreviations, addresses, versions", () => {
    assert.deepEqual(fileLinksIn("e.g. this, i.e. that"), []);
    assert.deepEqual(fileLinksIn("host 10.0.0.1 and 1.2.3"), []);
    assert.deepEqual(fileLinksIn("nothing to link here"), []);
  });

  it("opens on a click with the modifier held, and leaves a plain click to the CLI", () => {
    const opened: string[] = [];
    const [link] = linksAt(
      createFileLinkProvider(fakeTerminal([{ text: "see src/a.ts" }]), (path) => opened.push(path)),
      1,
    );
    link.activate(NOT_HELD, link.text);
    assert.deepEqual(opened, []);
    link.activate(HELD, link.text);
    assert.deepEqual(opened, ["src/a.ts"]);
  });

  it("reports the range of the match, 1-based, right side including", () => {
    const [link] = linksAt(
      createFileLinkProvider(fakeTerminal([{ text: "see src/a.ts" }]), () => undefined),
      1,
    );
    assert.deepEqual(link.range, { start: { x: 5, y: 1 }, end: { x: 12, y: 1 } });
  });
});

describe("url links", () => {
  it("finds a url, with its path and query", () => {
    assert.deepEqual(urlLinksIn("open https://example.com/a/b?c=1 please"), ["https://example.com/a/b?c=1"]);
  });

  it("finds a deep link of any scheme", () => {
    assert.deepEqual(urlLinksIn("msteams://l/meeting and vscode://file/x"), ["msteams://l/meeting", "vscode://file/x"]);
  });

  it("leaves the punctuation after a url out of it", () => {
    assert.deepEqual(urlLinksIn("see https://example.com/a."), ["https://example.com/a"]);
    assert.deepEqual(urlLinksIn("(https://example.com/a)"), ["https://example.com/a"]);
    assert.deepEqual(urlLinksIn('"https://example.com/a",'), ["https://example.com/a"]);
  });

  it("finds nothing without a scheme", () => {
    assert.deepEqual(urlLinksIn("example.com/a and mailto:x@y.z"), []);
  });
});

describe("a link across wrapped rows", () => {
  const url = "https://example.com/a/very/long/path/x";
  const cols = 24;

  it("is one link whose range runs over both rows", () => {
    const rows = [{ text: url.slice(0, cols) }, { text: url.slice(cols), wrapped: true }];
    const provider = createUrlLinkProvider(fakeTerminal(rows, cols), () => undefined);
    for (const row of [1, 2]) {
      const links = linksAt(provider, row);
      assert.deepEqual(
        links.map((link) => link.text),
        [url],
        `asked from row ${row}`,
      );
      assert.deepEqual(links[0].range, { start: { x: 1, y: 1 }, end: { x: url.length - cols, y: 2 } });
    }
  });

  it("is also one when a CLI wraps itself: the row above filled its last column", () => {
    const rows = [{ text: url.slice(0, cols) }, { text: "  " + url.slice(cols) }];
    const [link] = linksAt(
      createUrlLinkProvider(fakeTerminal(rows, cols), () => undefined),
      2,
    );
    assert.equal(link.text, url);
    // The continuation's indent is not part of the link.
    assert.deepEqual(link.range, { start: { x: 1, y: 1 }, end: { x: 2 + url.length - cols, y: 2 } });
  });
});
