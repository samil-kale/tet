/**
 * The color themes the settings dialog offers. One entry is one value set in
 * vscode-theme.css (`:root[data-theme="<id>"]`) plus what the two processes need before that
 * stylesheet exists or outside of it — hence shared, unlike the renderer-only keybinding presets.
 */
export interface ThemeDefinition {
  id: string;
  label: string;
  /** The token half: Dark/Light Modern take their tokenColors from Dark+/Light+ by `include`. */
  shikiTheme: "dark-plus" | "light-plus";
  /** Claude Code's own theme for this background, set in the `--settings` file tet hands it
   *  (see src/main/agents/claude/hooks.ts) — it does not look at the terminal itself. */
  claudeTheme: "dark" | "light";
  /** BrowserWindow's own paint color and the Windows title-bar overlay — set in main.ts before
   *  the renderer's CSS exists, so kept by hand in step with vscode-theme.css's
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
    claudeTheme: "dark",
    windowBackground: "#181818",
    titleBarSymbolColor: "#cccccc",
    terminalBackground: "#1f1f1f",
    terminalForeground: "#cccccc"
  },
  {
    id: "light-modern",
    label: "Light",
    shikiTheme: "light-plus",
    claudeTheme: "light",
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
