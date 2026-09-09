/** The color themes the settings dialog offers. One entry is one stylesheet in
 *  src/renderer/themes/<id>.css (`:root[data-theme="<id>"]`) plus what both processes need before
 *  that stylesheet exists. pieces.test.ts checks the two halves agree. */
export interface ThemeDefinition {
  id: string;
  label: string;
  /** The token half: Dark/Light Modern take their tokenColors from Dark+/Light+ by `include`. */
  shikiTheme: "dark-plus" | "light-plus";
  /** Which way the background is — VS Code's theme `type`. Claude Code's `theme` and pi's
   *  `--use-theme` name their built-in themes after it. */
  kind: "dark" | "light";
  /** BrowserWindow's paint color and the Windows title-bar overlay — set in main.ts before the
   *  renderer's CSS exists, so kept by hand in step with --vscode-titleBar-active{Background,Foreground}. */
  windowBackground: string;
  titleBarSymbolColor: string;
  /** The terminal's colors, for an agent reading them off the console (Codex on win32). Kept in
   *  step with --vscode-terminal-background / -foreground by hand. */
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

/** The setting's value for "whichever the OS is in". Not a theme: `currentTheme` in
 *  src/main/theme.ts turns it into one of the ids above before any reader sees it. */
export const SYSTEM_THEME_ID = "system";

/** An id the list no longer knows is the default — the same contract as the keybinding preset. */
export function resolveTheme(id: string | undefined): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME_ID)!;
}
