import type { ITheme } from "@xterm/xterm";

const ANSI_CSS_VARS: Record<string, string> = {
  black: "--vscode-terminal-ansiBlack",
  red: "--vscode-terminal-ansiRed",
  green: "--vscode-terminal-ansiGreen",
  yellow: "--vscode-terminal-ansiYellow",
  blue: "--vscode-terminal-ansiBlue",
  magenta: "--vscode-terminal-ansiMagenta",
  cyan: "--vscode-terminal-ansiCyan",
  white: "--vscode-terminal-ansiWhite",
  brightBlack: "--vscode-terminal-ansiBrightBlack",
  brightRed: "--vscode-terminal-ansiBrightRed",
  brightGreen: "--vscode-terminal-ansiBrightGreen",
  brightYellow: "--vscode-terminal-ansiBrightYellow",
  brightBlue: "--vscode-terminal-ansiBrightBlue",
  brightMagenta: "--vscode-terminal-ansiBrightMagenta",
  brightCyan: "--vscode-terminal-ansiBrightCyan",
  brightWhite: "--vscode-terminal-ansiBrightWhite"
};

/** The theme's editor font, resolved for xterm and monaco alike, which take no var(). */
export function editorFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim() || "monospace";
}

/** xterm draws on canvas and needs resolved colors, not var() references. */
export function buildXtermTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string): string | undefined => styles.getPropertyValue(name).trim() || undefined;

  const background = read("--vscode-terminal-background") ?? read("--vscode-editor-background");
  const foreground = read("--vscode-terminal-foreground") ?? read("--vscode-editor-foreground");
  const theme: ITheme = {
    background,
    foreground,
    // xterm's default cursor and selection are white — invisible on a light background. xterm
    // thins an opaque selection to 30% itself.
    cursor: read("--vscode-terminalCursor-foreground") ?? foreground,
    cursorAccent: background,
    selectionBackground: read("--vscode-terminal-selectionBackground") ?? read("--vscode-editor-selectionBackground"),
    selectionInactiveBackground:
      read("--vscode-terminal-inactiveSelectionBackground") ?? read("--vscode-editor-inactiveSelectionBackground"),
    // xterm's right-edge lane, invisible. A theme color, not CSS: xterm repaints its own elements
    // with it. `#00000000`, not `transparent`: it goes through xterm's color parser. The theme's
    // scrollbar variables are for the app's lists.
    scrollbarSliderBackground: "#00000000",
    scrollbarSliderHoverBackground: "#00000000",
    scrollbarSliderActiveBackground: "#00000000",
    // The ruler outlines itself every frame (`_renderRulerOutline`); xterm's default draws a
    // white line down the right of every terminal.
    overviewRulerBorder: "#00000000"
  };

  for (const [key, cssVar] of Object.entries(ANSI_CSS_VARS)) {
    (theme as Record<string, string | undefined>)[key] = read(cssVar);
  }

  return theme;
}

/** Resolves color id → --vscode-* variable, skipping unset ones. */
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
  "editor.background": "--vscode-editor-background",
  "editor.foreground": "--vscode-editor-foreground",
  "editorLineNumber.foreground": "--vscode-editorLineNumber-foreground",
  "editorLineNumber.activeForeground": "--vscode-editorLineNumber-activeForeground",
  "editorCursor.foreground": "--vscode-editorCursor-foreground",
  "editor.selectionBackground": "--vscode-editor-selectionBackground",
  "editor.inactiveSelectionBackground": "--vscode-editor-inactiveSelectionBackground",
  "editor.lineHighlightBorder": "--vscode-editor-lineHighlightBorder",
  "editor.findMatchBackground": "--vscode-editor-findMatchBackground",
  "editor.findMatchHighlightBackground": "--vscode-editor-findMatchHighlightBackground",
  "editorIndentGuide.background1": "--vscode-editorIndentGuide-background1",
  "editorIndentGuide.activeBackground1": "--vscode-editorIndentGuide-activeBackground1",
  "editorWidget.background": "--vscode-editorWidget-background",
  // The find widget's text and, through `styles.css`, its buttons: unset, monaco falls back to the
  // shiki theme's own foreground, which is the one color in the widget not from tet's stylesheet.
  "editorWidget.foreground": "--vscode-foreground",
  "editorWidget.border": "--vscode-editorWidget-border",
  "widget.shadow": "--vscode-widget-shadow"
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
  "input.background": "--vscode-input-background",
  "input.foreground": "--vscode-input-foreground",
  "input.border": "--vscode-input-border",
  "input.placeholderForeground": "--vscode-input-placeholderForeground",
  focusBorder: "--vscode-focusBorder",
  // The find widget's Aa/ab/.* toggles: an action button's hover grey, not monaco's `#007ACC`.
  "inputOption.activeForeground": "--vscode-foreground",
  "inputOption.activeBackground": "--vscode-toolbar-hoverBackground",
  "scrollbarSlider.background": "--vscode-scrollbarSlider-background",
  "scrollbarSlider.hoverBackground": "--vscode-scrollbarSlider-hoverBackground",
  "scrollbarSlider.activeBackground": "--vscode-scrollbarSlider-activeBackground",
  "menu.background": "--vscode-menu-background",
  "menu.foreground": "--vscode-menu-foreground",
  "menu.border": "--vscode-menu-border",
  "menu.selectionBackground": "--vscode-menu-selectionBackground",
  "menu.selectionForeground": "--vscode-menu-selectionForeground",
  "menu.separatorBackground": "--vscode-menu-separatorBackground",
  "list.hoverBackground": "--vscode-list-hoverBackground",
  "list.activeSelectionBackground": "--vscode-list-activeSelectionBackground",
  "list.activeSelectionForeground": "--vscode-list-activeSelectionForeground",
  // The inline diff: lines, words, gutter, and the overview ruler — how a change is found at all,
  // so set rather than left to monaco's doubled-alpha fallback.
  "diffEditor.insertedLineBackground": "--vscode-diffEditor-insertedLineBackground",
  "diffEditor.removedLineBackground": "--vscode-diffEditor-removedLineBackground",
  "diffEditor.insertedTextBackground": "--vscode-diffEditor-insertedTextBackground",
  "diffEditor.removedTextBackground": "--vscode-diffEditor-removedTextBackground",
  "diffEditorGutter.insertedLineBackground": "--vscode-diffEditor-insertedLineBackground",
  "diffEditorGutter.removedLineBackground": "--vscode-diffEditor-removedLineBackground",
  "diffEditorOverview.insertedForeground": "--vscode-diffEditorOverview-insertedForeground",
  "diffEditorOverview.removedForeground": "--vscode-diffEditorOverview-removedForeground"
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
