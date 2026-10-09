import type { ITheme } from "@xterm/xterm";

/** xterm's theme keys → --tet-* variable; every one is required of each theme (THEMES.md). */
const XTERM_CSS_VARS: Record<string, string> = {
  background: "--tet-terminal-background",
  foreground: "--tet-terminal-foreground",
  // xterm's default cursor and selection are white — invisible on a light background. xterm
  // thins an opaque selection to 30% itself.
  cursor: "--tet-terminalCursor-foreground",
  selectionBackground: "--tet-terminal-selectionBackground",
  selectionInactiveBackground: "--tet-terminal-inactiveSelectionBackground",
  black: "--tet-terminal-ansiBlack",
  red: "--tet-terminal-ansiRed",
  green: "--tet-terminal-ansiGreen",
  yellow: "--tet-terminal-ansiYellow",
  blue: "--tet-terminal-ansiBlue",
  magenta: "--tet-terminal-ansiMagenta",
  cyan: "--tet-terminal-ansiCyan",
  white: "--tet-terminal-ansiWhite",
  brightBlack: "--tet-terminal-ansiBrightBlack",
  brightRed: "--tet-terminal-ansiBrightRed",
  brightGreen: "--tet-terminal-ansiBrightGreen",
  brightYellow: "--tet-terminal-ansiBrightYellow",
  brightBlue: "--tet-terminal-ansiBrightBlue",
  brightMagenta: "--tet-terminal-ansiBrightMagenta",
  brightCyan: "--tet-terminal-ansiBrightCyan",
  brightWhite: "--tet-terminal-ansiBrightWhite",
};

/** The theme's editor font, resolved for xterm and monaco alike, which take no var(). */
export function editorFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--tet-editor-font-family").trim() || "monospace";
}

/** xterm draws on canvas and needs resolved colors, not var() references. */
export function buildXtermTheme(): ITheme {
  const colors = readCssVars(XTERM_CSS_VARS);
  return {
    ...colors,
    cursorAccent: colors.background,
    // xterm's right-edge lane, invisible. A theme color, not CSS: xterm repaints its own elements
    // with it. `#00000000`, not `transparent`: it goes through xterm's color parser. The theme's
    // scrollbar variables are for the app's lists.
    scrollbarSliderBackground: "#00000000",
    scrollbarSliderHoverBackground: "#00000000",
    scrollbarSliderActiveBackground: "#00000000",
    // The ruler outlines itself every frame (`_renderRulerOutline`); xterm's default draws a
    // white line down the right of every terminal.
    overviewRulerBorder: "#00000000",
  };
}

/** Resolves color id → --tet-* variable, skipping unset ones. */
function readCssVars(vars: Record<string, string>): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const [id, cssVar] of Object.entries(vars)) {
    const value = styles.getPropertyValue(cssVar).trim();
    if (value) {
      colors[id] = value;
    }
  }
  return colors;
}

/**
 * The editor surface's VS Code color ids (shiki's theme.colors namespace). Shiki's theme is patched
 * with these at load (`diff-highlight.ts`); monaco inherits them from it (`editor.ts`'s
 * `applyChrome`).
 */
const EDITOR_CSS_VARS: Record<string, string> = {
  "editor.background": "--tet-editor-background",
  "editor.foreground": "--tet-editor-foreground",
  "editorLineNumber.foreground": "--tet-editorLineNumber-foreground",
  "editorLineNumber.activeForeground": "--tet-editorLineNumber-activeForeground",
  "editorCursor.foreground": "--tet-editorCursor-foreground",
  "editor.selectionBackground": "--tet-editor-selectionBackground",
  "editor.inactiveSelectionBackground": "--tet-editor-inactiveSelectionBackground",
  "editor.lineHighlightBorder": "--tet-editor-lineHighlightBorder",
  "editor.findMatchBackground": "--tet-editor-findMatchBackground",
  "editor.findMatchHighlightBackground": "--tet-editor-findMatchHighlightBackground",
  "editorIndentGuide.background1": "--tet-editorIndentGuide-background1",
  "editorIndentGuide.activeBackground1": "--tet-editorIndentGuide-activeBackground1",
  "editorWidget.background": "--tet-editorWidget-background",
  // The find widget's text, its buttons the same variable in `styles.css`: unset, monaco falls back
  // to the shiki theme's own foreground, which is the one color in the widget not from TET's
  // stylesheet.
  "editorWidget.foreground": "--tet-foreground",
  "editorWidget.border": "--tet-editorWidget-border",
  "widget.shadow": "--tet-widget-shadow",
};

/** The editor surface's colors, read for shiki's theme — see `EDITOR_CSS_VARS`. */
export function buildShikiColors(): Record<string, string> {
  return readCssVars(EDITOR_CSS_VARS);
}

/**
 * monaco colors shiki's theme has no notion of: chrome (menus, inputs, lists) and the diff. The
 * editor surface comes from shiki's theme (`EDITOR_CSS_VARS`).
 *
 * Not CSS alone: monaco writes its own `--vscode-*` block onto `.monaco-editor,
 * .monaco-diff-editor` (`standaloneThemeService`), shadowing our `:root` inside the widget. Only
 * `defineTheme`'s colors reach it.
 */
const MONACO_CSS_VARS: Record<string, string> = {
  "input.background": "--tet-input-background",
  "input.foreground": "--tet-input-foreground",
  "input.border": "--tet-input-border",
  "input.placeholderForeground": "--tet-input-placeholderForeground",
  focusBorder: "--tet-focusBorder",
  // The find widget's Aa/ab/.* toggles: an action button's hover grey, not monaco's `#007ACC`.
  "inputOption.activeForeground": "--tet-foreground",
  "inputOption.activeBackground": "--tet-toolbar-hoverBackground",
  "scrollbarSlider.background": "--tet-scrollbarSlider-background",
  "scrollbarSlider.hoverBackground": "--tet-scrollbarSlider-hoverBackground",
  "scrollbarSlider.activeBackground": "--tet-scrollbarSlider-activeBackground",
  "menu.background": "--tet-menu-background",
  "menu.foreground": "--tet-menu-foreground",
  "menu.border": "--tet-menu-border",
  "menu.selectionBackground": "--tet-menu-selectionBackground",
  "menu.selectionForeground": "--tet-menu-selectionForeground",
  "menu.separatorBackground": "--tet-menu-separatorBackground",
  "list.hoverBackground": "--tet-list-hoverBackground",
  "list.activeSelectionBackground": "--tet-list-activeSelectionBackground",
  "list.activeSelectionForeground": "--tet-list-activeSelectionForeground",
  // The inline diff: lines, words, gutter, and the overview ruler — how a change is found at all,
  // so set rather than left to monaco's doubled-alpha fallback.
  "diffEditor.insertedLineBackground": "--tet-diffEditor-insertedLineBackground",
  "diffEditor.removedLineBackground": "--tet-diffEditor-removedLineBackground",
  "diffEditor.insertedTextBackground": "--tet-diffEditor-insertedTextBackground",
  "diffEditor.removedTextBackground": "--tet-diffEditor-removedTextBackground",
  "diffEditorGutter.insertedLineBackground": "--tet-diffEditor-insertedLineBackground",
  "diffEditorGutter.removedLineBackground": "--tet-diffEditor-removedLineBackground",
  "diffEditorOverview.insertedForeground": "--tet-diffEditorOverview-insertedForeground",
  "diffEditorOverview.removedForeground": "--tet-diffEditorOverview-removedForeground",
};

/** `MONACO_CSS_VARS` plus a few fixed values, laid over shiki's theme. */
export function buildMonacoColors(): Record<string, string> {
  const colors = readCssVars(MONACO_CSS_VARS);
  // No border around an active toggle, just its background.
  colors["inputOption.activeBorder"] = "#00000000";
  // No `.shadow.top` once scrolled — nothing else in the app marks "scrolled" that way.
  colors["scrollbar.shadow"] = "#00000000";
  return colors;
}
