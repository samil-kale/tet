/**
 * The color themes the settings dialog offers. One entry is one stylesheet in
 * src/renderer/themes/<id>.css (`:root[data-theme="<id>"]`) plus what the two processes need
 * before that stylesheet exists or outside of it — hence shared, unlike the renderer-only
 * keybinding presets. pieces.test.ts checks the two halves agree.
 */
export interface ThemeDefinition {
  id: string;
  label: string;
  /** The token half: Dark/Light Modern take their tokenColors from Dark+/Light+ by `include`. */
  shikiTheme: "dark-plus" | "light-plus";
  /** Which way the background is — VS Code's theme `type`. What an agent that paints its own
   *  frame rather than reading the terminal's colors is told when the Appearance switch is on:
   *  Claude Code's `theme` in the `--settings` file tet hands it (src/main/agents/claude/hooks.ts)
   *  and pi's `--use-theme` (src/main/agents/pi) both name their built-in themes after it. */
  kind: "dark" | "light";
  /** BrowserWindow's own paint color and the Windows title-bar overlay — set in main.ts before
   *  the renderer's CSS exists, so kept by hand in step with the stylesheet's
   *  --vscode-titleBar-activeBackground / -activeForeground for this theme. */
  windowBackground: string;
  titleBarSymbolColor: string;
  /** The terminal's own colors, for an agent that reads them off the console rather than
   *  the terminal (Codex on win32 — see src/main/agents/codex/index.ts). Kept in step with
   *  --vscode-terminal-background / -foreground the same way. */
  terminalBackground: string;
  terminalForeground: string;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: "dark-modern",
    label: "Dark",
    shikiTheme: "dark-plus",
    kind: "dark",
    windowBackground: "#181818",
    titleBarSymbolColor: "#cccccc",
    terminalBackground: "#1f1f1f",
    terminalForeground: "#cccccc"
  },
  {
    id: "dark-slate",
    label: "Dark Slate",
    shikiTheme: "dark-plus",
    kind: "dark",
    windowBackground: "#14171c",
    titleBarSymbolColor: "#dde2e9",
    terminalBackground: "#1b1f27",
    terminalForeground: "#dde2e9"
  },
  {
    id: "light-modern",
    label: "Light",
    shikiTheme: "light-plus",
    kind: "light",
    windowBackground: "#f8f8f8",
    titleBarSymbolColor: "#1e1e1e",
    terminalBackground: "#ffffff",
    terminalForeground: "#3b3b3b"
  }
];

export const DEFAULT_THEME_ID = "dark-modern";

/**
 * The setting's value for "whichever the OS is in", and the dialog's first entry. Not a theme:
 * it never reaches `resolveTheme`, since only the main process can ask the OS — `currentTheme`
 * in src/main/theme.ts turns it into one of the ids above, and that is what every reader
 * (the renderer, the agents) gets handed.
 */
export const SYSTEM_THEME_ID = "system";

/** An id the list no longer knows is the default — the same contract as the keybinding preset. */
export function resolveTheme(id: string | undefined): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME_ID)!;
}
