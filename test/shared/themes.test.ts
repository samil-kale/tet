import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_THEME_IDS, THEMES } from "../../src/shared/themes";
import { ROOT } from "../helpers";

/** shared/themes.ts: every theme, complete and consistent. */

describe("the color themes", () => {
  const dir = path.join(ROOT, "src", "renderer", "themes");
  const sheets = new Map(THEMES.map((theme) => [theme.id, fs.readFileSync(path.join(dir, `${theme.id}.css`), "utf8")]));
  const declared = (css: string): string[] => [...css.matchAll(/^\s+(color-scheme|--tet-[\w-]+):/gm)].map((m) => m[1]);
  const valueOf = (css: string, name: string): string | undefined => css.match(new RegExp(`${name}:([^;]+);`))?.[1].trim();

  it("has one stylesheet per entry in THEMES, and none besides", () => {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".css"))
      .sort();
    assert.deepEqual(files, THEMES.map((theme) => `${theme.id}.css`).sort());
    for (const [id, css] of sheets) {
      assert.ok(css.includes(`:root[data-theme="${id}"]`), `${id}.css declares its own block`);
    }
  });

  // A variable forgotten in one stylesheet would show a value falling through from another theme. One
  // beyond the bare `:root`'s theme is optional, read only behind a fallback (test/lint.test.ts).
  it("declares every variable of the bare :root's theme in every stylesheet, each variable once", () => {
    const reference = DEFAULT_THEME_IDS.dark;
    const expected = declared(sheets.get(reference)!).sort();
    for (const [id, css] of sheets) {
      const names = declared(css);
      assert.equal(new Set(names).size, names.length, `${id}.css declares nothing twice`);
      assert.deepEqual(names.filter((name) => expected.includes(name)).sort(), expected, `${id}.css against ${reference}.css`);
    }
  });

  // Hand-kept copies of four stylesheet values, for code that needs them outside the renderer's CSS.
  it("keeps each definition's window and terminal colors in step with its stylesheet", () => {
    for (const theme of THEMES) {
      const css = sheets.get(theme.id)!;
      assert.equal(valueOf(css, "--tet-titleBar-activeBackground"), theme.windowBackground, theme.id);
      assert.equal(valueOf(css, "--tet-titleBar-activeForeground"), theme.titleBarSymbolColor, theme.id);
      assert.equal(valueOf(css, "--tet-terminal-background"), theme.terminalBackground, theme.id);
      assert.equal(valueOf(css, "--tet-terminal-foreground"), theme.terminalForeground, theme.id);
    }
  });
});
