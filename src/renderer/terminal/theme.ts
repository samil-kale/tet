import type { ITheme } from "@xterm/xterm";
import type { AgentInfo } from "../../shared/types";

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

/**
 * xterm renders on canvas and needs resolved color values, not CSS var() references, so the
 * --vscode-* custom properties are read out into a plain xterm ITheme. One thing in it depends
 * on the agent (see the swap below), so this is built per terminal, not once for the window.
 */
export function buildXtermTheme(agent: AgentInfo): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string): string | undefined => styles.getPropertyValue(name).trim() || undefined;

  const background = read("--vscode-terminal-background") ?? read("--vscode-editor-background");
  const foreground = read("--vscode-terminal-foreground") ?? read("--vscode-editor-foreground");
  const theme: ITheme = {
    background,
    foreground,
    // Left to xterm, cursor and selection are white (`#ffffff`, `rgba(255, 255, 255, .3)`) —
    // invisible on a light background. An unset terminal cursor falls back to the terminal
    // foreground, an unset terminal selection to the editor's. xterm thins an opaque selection
    // to 30% itself.
    cursor: read("--vscode-terminalCursor-foreground") ?? foreground,
    cursorAccent: background,
    selectionBackground: read("--vscode-terminal-selectionBackground") ?? read("--vscode-editor-selectionBackground"),
    selectionInactiveBackground:
      read("--vscode-terminal-inactiveSelectionBackground") ?? read("--vscode-editor-inactiveSelectionBackground"),
    // Everything xterm draws down the lane at the right edge, made invisible. Color rather than
    // CSS: both are xterm's own elements, redrawn as the buffer grows, and this is the value
    // they are painted with. Spelled `#00000000` and not `transparent`, since it goes through
    // xterm's color parser on the way to a stylesheet and a canvas. The theme layer's own
    // scrollbar variables are not read here — they are for the app's lists.
    scrollbarSliderBackground: "#00000000",
    scrollbarSliderHoverBackground: "#00000000",
    scrollbarSliderActiveBackground: "#00000000",
    // The ruler outlines itself on every frame whether or not a mark is in it, and this is the
    // color it uses (`_renderRulerOutline`). Left unset, xterm's default is light: a white line
    // down the right of every terminal.
    overviewRulerBorder: "#00000000"
  };

  // opencode's TUI draws blue and magenta the other way round (observed, not derived — see
  // AgentDefinition.swapsBlueMagenta).
  const ansiCssVars = agent.swapsBlueMagenta
    ? { ...ANSI_CSS_VARS, blue: ANSI_CSS_VARS.magenta, magenta: ANSI_CSS_VARS.blue }
    : ANSI_CSS_VARS;

  for (const [key, cssVar] of Object.entries(ansiCssVars)) {
    (theme as Record<string, string | undefined>)[key] = read(cssVar);
  }

  return theme;
}

/** Reads a map of theme color ids to --vscode-* variables into resolved values, skipping unset ones. */
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
 * VS Code color ids to the --vscode-* variable they read, for the editor surface itself — the
 * same dotted namespace shiki's own theme.colors uses. Read once here: shiki's theme is patched
 * with these at load time (`diff-highlight.ts`), and monaco inherits them from shiki's theme in
 * turn (`editor.ts`'s `applyChrome`).
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
  "editorWidget.border": "--vscode-editorWidget-border",
  "widget.shadow": "--vscode-widget-shadow"
};

/** The editor surface's colors, read for shiki's theme — see `EDITOR_CSS_VARS`. */
export function buildShikiColors(): Record<string, string> {
  return readCssVars(EDITOR_CSS_VARS);
}

/**
 * monaco color id to the --vscode-* variable it reads, for chrome shiki's theme has no notion of
 * (menus, inputs, lists) and for the diff. The editor surface is not repeated here: it comes from
 * shiki's own theme, already patched with `EDITOR_CSS_VARS`.
 *
 * The diff colors have to travel this way rather than through CSS alone: monaco writes its own
 * `--vscode-*` block onto `.monaco-editor, .monaco-diff-editor` (its `standaloneThemeService`),
 * which is more specific than our `:root` and shadows every variable inside the widget. A theme
 * value only reaches the diff through `defineTheme`'s colors, which is what this map feeds.
 */
const MONACO_CSS_VARS: Record<string, string> = {
  "input.background": "--vscode-input-background",
  "input.foreground": "--vscode-input-foreground",
  "input.border": "--vscode-input-border",
  "input.placeholderForeground": "--vscode-input-placeholderForeground",
  focusBorder: "--vscode-focusBorder",
  // The find widget's Aa/ab/.* toggles: the same translucent grey an action button hovers with,
  // rather than monaco's default `#007ACC` border and recoloured icon.
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
  // The diff, inline: a changed line's ground, the changed words within it, the same tone in the
  // gutter beside a removed-line view zone, and the overview ruler beside the scrollbar — which is
  // how a change is found at all, so it is set rather than left to monaco's doubled-alpha fallback.
  "diffEditor.insertedLineBackground": "--vscode-diffEditor-insertedLineBackground",
  "diffEditor.removedLineBackground": "--vscode-diffEditor-removedLineBackground",
  "diffEditor.insertedTextBackground": "--vscode-diffEditor-insertedTextBackground",
  "diffEditor.removedTextBackground": "--vscode-diffEditor-removedTextBackground",
  "diffEditorGutter.insertedLineBackground": "--vscode-diffEditor-insertedLineBackground",
  "diffEditorGutter.removedLineBackground": "--vscode-diffEditor-removedLineBackground",
  "diffEditorOverview.insertedForeground": "--vscode-diffEditorOverview-insertedForeground",
  "diffEditorOverview.removedForeground": "--vscode-diffEditorOverview-removedForeground"
};

/**
 * Monaco's own chrome (menus, inputs, lists) as color overrides; everything else is left to
 * monaco's vs-dark defaults. The editor surface is not part of this — monaco gets that from
 * shiki's theme (`editor.ts`'s `applyChrome`).
 */
export function buildMonacoColors(): Record<string, string> {
  const colors = readCssVars(MONACO_CSS_VARS);
  // No border box around an active toggle — just the background set through the map above.
  colors["inputOption.activeBorder"] = "#00000000";
  // Monaco paints a shadow along the top edge once the editor is scrolled (its `.shadow.top`
  // decoration, black in vs-dark). Nothing else in the app marks "scrolled" that way.
  colors["scrollbar.shadow"] = "#00000000";
  return colors;
}
