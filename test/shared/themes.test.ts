import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { THEMES } from "../../src/shared/themes";
import { ROOT } from "../helpers";

/** shared/themes.ts: every theme, complete and consistent. */

describe("the color themes", () => {
  const dir = path.join(ROOT, "src", "renderer", "themes");
  const sheets = new Map(THEMES.map((theme) => [theme.id, fs.readFileSync(path.join(dir, `${theme.id}.css`), "utf8")]));
  const declared = (css: string): string[] => [...css.matchAll(/^\s+(color-scheme|--vscode-[\w-]+):/gm)].map((m) => m[1]);
  const valueOf = (css: string, name: string): string | undefined => css.match(new RegExp(`${name}:([^;]+);`))?.[1].trim();

  it("has one stylesheet per entry in THEMES, and none besides", () => {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".css")).sort();
    assert.deepEqual(files, THEMES.map((theme) => `${theme.id}.css`).sort());
    for (const [id, css] of sheets) {
      assert.ok(css.includes(`:root[data-theme="${id}"]`), `${id}.css declares its own block`);
    }
  });

  // A variable forgotten in one stylesheet would show a value falling through from another theme.
  it("declares the complete variable list in every stylesheet, each variable once", () => {
    const [reference, ...others] = [...sheets];
    const expected = declared(reference[1]).sort();
    assert.equal(new Set(expected).size, expected.length, `${reference[0]}.css declares nothing twice`);
    for (const [id, css] of others) {
      const names = declared(css);
      assert.equal(new Set(names).size, names.length, `${id}.css declares nothing twice`);
      assert.deepEqual(names.sort(), expected, `${id}.css against ${reference[0]}.css`);
    }
  });

  // Hand-kept copies of four stylesheet values, for code that needs them outside the renderer's CSS.
  it("keeps each definition's window and terminal colors in step with its stylesheet", () => {
    for (const theme of THEMES) {
      const css = sheets.get(theme.id)!;
      assert.equal(valueOf(css, "--vscode-titleBar-activeBackground"), theme.windowBackground, theme.id);
      assert.equal(valueOf(css, "--vscode-titleBar-activeForeground"), theme.titleBarSymbolColor, theme.id);
      assert.equal(valueOf(css, "--vscode-terminal-background"), theme.terminalBackground, theme.id);
      assert.equal(valueOf(css, "--vscode-terminal-foreground"), theme.terminalForeground, theme.id);
    }
  });
});
