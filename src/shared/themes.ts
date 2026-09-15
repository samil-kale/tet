/** The color themes the settings dialog offers. One entry is one stylesheet in
 *  src/renderer/themes/<id>.css (`:root[data-theme="<id>"]`) plus what both processes need before
 *  that stylesheet exists. pieces.test.ts checks the two halves agree. */
export interface ThemeDefinition {
  id: string;
  label: string;
  /** The token half: Dark/Light Modern take their tokenColors from Dark+/Light+ by `include`;
   *  Dark Slate's theme file is tet's own (src/renderer/themes/dark-slate.json). */
  shikiTheme: "dark-plus" | "light-plus" | "github-dark-default" | "github-light-default" | "dark-slate";
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
    label: "Dark Modern",
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
    shikiTheme: "dark-slate",
    kind: "dark",
    windowBackground: "#14171c",
    titleBarSymbolColor: "#dde2e9",
    terminalBackground: "#1b1f27",
    terminalForeground: "#dde2e9"
  },
  {
    id: "dark-github",
    label: "Dark GitHub",
    shikiTheme: "github-dark-default",
    kind: "dark",
    windowBackground: "#0d1117",
    titleBarSymbolColor: "#7d8590",
    terminalBackground: "#0d1117",
    terminalForeground: "#e6edf3"
  },
  {
    id: "light-modern",
    label: "Light Modern",
    shikiTheme: "light-plus",
    kind: "light",
    windowBackground: "#f8f8f8",
    titleBarSymbolColor: "#1e1e1e",
    terminalBackground: "#ffffff",
    terminalForeground: "#3b3b3b"
  },
  {
    id: "light-github",
    label: "Light GitHub",
    shikiTheme: "github-light-default",
    kind: "light",
    windowBackground: "#ffffff",
    titleBarSymbolColor: "#656d76",
    terminalBackground: "#ffffff",
    terminalForeground: "#1f2328"
  }
];

export type ThemeKind = ThemeDefinition["kind"];

/** Each kind's theme before anyone picked one. */
export const DEFAULT_THEME_IDS: Readonly<Record<ThemeKind, string>> = { dark: "dark-modern", light: "light-modern" };

export const DEFAULT_THEME_ID = DEFAULT_THEME_IDS.dark;

/** An id the list no longer knows — or, given a kind, one of the other kind — is the default: the
 *  same contract as the keybinding preset. */
export function resolveTheme(id: string | undefined, kind?: ThemeKind): ThemeDefinition {
  return (
    THEMES.find((theme) => theme.id === id && (!kind || theme.kind === kind)) ??
    THEMES.find((theme) => theme.id === (kind ? DEFAULT_THEME_IDS[kind] : DEFAULT_THEME_ID))!
  );
}
