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
 * --vscode-* custom properties of the theme layer are read out into a plain xterm ITheme.
 *
 * One thing in it depends on the agent (see the swap below), so a terminal's theme is built per
 * terminal rather than once for the window.
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
    // invisible on a light background. The fallbacks are VS Code's own: an unset terminal
    // cursor is the terminal foreground, an unset terminal selection the editor's. xterm
    // thins an opaque selection to 30% itself, as VS Code's does.
    cursor: read("--vscode-terminalCursor-foreground") ?? foreground,
    cursorAccent: background,
    selectionBackground: read("--vscode-terminal-selectionBackground") ?? read("--vscode-editor-selectionBackground"),
    selectionInactiveBackground:
      read("--vscode-terminal-inactiveSelectionBackground") ?? read("--vscode-editor-inactiveSelectionBackground"),
    // Everything xterm draws down the lane at the right edge, made invisible — a scrollbar has
    // no business beside a TUI (see styles.css), and the ruler is only there to keep FitAddon
    // from reserving room for one (see terminal-views.ts). Color rather than CSS is what does
    // it: both are xterm's own elements, redrawn as the buffer grows, and this is the value
    // they are painted with. Spelled `#00000000` and not `transparent`, since it goes through
    // xterm's color parser on the way to a stylesheet and a canvas.
    //
    // The theme layer's own scrollbar variables are deliberately not read here: they are for
    // the app's lists, where a slider is exactly what you want.
    scrollbarSliderBackground: "#00000000",
    scrollbarSliderHoverBackground: "#00000000",
    scrollbarSliderActiveBackground: "#00000000",
    // The ruler outlines itself on every frame whether or not a mark is in it, and this is the
    // color it uses (`_renderRulerOutline`). Left unset, xterm's default is light: a white line
    // down the right of every terminal.
    overviewRulerBorder: "#00000000"
  };

  // opencode's TUI draws blue and magenta the other way round — the story, observed and not
  // derived, is at AgentDefinition.swapsBlueMagenta, whose value travels here as a flag on
  // AgentInfo: that interface is the main process's, and the renderer is where a colour is
  // resolved.
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
 * VS Code color ids to the --vscode-* variable they read, for the editor surface itself
 * (background, gutter, selection, widgets...) — the same dotted namespace shiki's own theme.colors
 * uses. Read once here rather than per consumer: shiki's theme is patched with these at load time
 * (see diff-highlight.ts's `highlighter`), and monaco inherits them from shiki's theme in turn (see
 * editor.ts's `applyChrome`) — so a theme swap only ever means changing the variables, not two
 * separate color maps.
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
 * monaco color id to the --vscode-* variable it reads, for chrome shiki's theme has no notion of —
 * menus, inputs, lists — see editor.ts's `applyChrome`. The editor surface itself is not repeated
 * here: it comes from shiki's own theme, already patched with `EDITOR_CSS_VARS` at load time.
 */
const MONACO_CSS_VARS: Record<string, string> = {
  "input.background": "--vscode-input-background",
  "input.foreground": "--vscode-input-foreground",
  "input.border": "--vscode-input-border",
  "input.placeholderForeground": "--vscode-input-placeholderForeground",
  focusBorder: "--vscode-focusBorder",
  // The find widget's Aa/ab/.* toggles: a plain, persistent background when on — the same
  // translucent grey an action button already hovers with everywhere else — rather than monaco's
  // own default of a `#007ACC` border and a recoloured icon. No colour at all, not even the
  // shared accent: an icon-button toggle turning blue reads fine standing alone, but these three
  // sit in a row together, and a row of icons some blue and some not reads as broken, not toggled.
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
  "list.activeSelectionForeground": "--vscode-list-activeSelectionForeground"
};

/**
 * Monaco's own chrome (menus, inputs, lists...) as color overrides, read the same way
 * `buildXtermTheme` reads xterm's — everything else (bracket match, hover widget, suggest
 * widget...) is left to monaco's own vs-dark defaults, which are VS Code's own values anyway.
 * The editor surface is not part of this: monaco gets that from shiki's theme (see editor.ts's
 * `applyChrome`), which is already patched with `EDITOR_CSS_VARS`.
 */
export function buildMonacoColors(): Record<string, string> {
  const colors = readCssVars(MONACO_CSS_VARS);
  // No border box around an active toggle — just the background set through the map above.
  colors["inputOption.activeBorder"] = "#00000000";
  // Monaco paints a shadow along the top edge once the editor is scrolled (its `.shadow.top`
  // decoration, vs-dark's default being black). Nothing else in the app marks "scrolled"
  // that way — not xterm, not the diff view — so the editor doesn't either.
  colors["scrollbar.shadow"] = "#00000000";
  return colors;
}
