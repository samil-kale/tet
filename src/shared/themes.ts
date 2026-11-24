import type { ColorScheme } from "./types/settings";

/** A color theme: one stylesheet in src/renderer/themes/<id>.css (`:root[data-theme="<id>"]`) plus
 *  what both processes need before it loads. test/shared/themes.test.ts checks the two halves
 *  agree. */
export interface ThemeDefinition {
  id: string;
  /** Without "Dark"/"Light": the dialog lists a kind's themes under that kind. */
  label: string;
  /** Token colors: Dark/Light Modern `include` Dark+/Light+; Dark Slate's is TET's own
   *  (src/renderer/themes/dark-slate.json), the IntelliJ and Claude themes' their
   *  extensions', beside it. */
  shikiTheme:
    | "dark-plus"
    | "light-plus"
    | "github-dark-default"
    | "github-light-default"
    | "dark-slate"
    | "dark-intellij"
    | "dracula"
    | "dark-claude"
    | "light-intellij"
    | "light-claude";
  /** VS Code's theme `type`; also Claude Code's `theme` and pi's `--use-theme` value. */
  kind: "dark" | "light";
  /** BrowserWindow paint and Windows title-bar overlay, set before the CSS exists — kept in step
   *  with --tet-app-background and --tet-titleBar-activeForeground by hand. */
  windowBackground: string;
  titleBarSymbolColor: string;
  /** For an agent reading colors off the console (Codex on win32). Kept in step with
   *  --tet-editor-background and --tet-terminal-foreground by hand. */
  terminalBackground: string;
  terminalForeground: string;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: "dark-modern",
    label: "VS Code",
    shikiTheme: "dark-plus",
    kind: "dark",
    windowBackground: "#191a1b",
    titleBarSymbolColor: "#8c8c8c",
    terminalBackground: "#121314",
    terminalForeground: "#cccccc",
  },
  {
    id: "dark-slate",
    label: "Slate",
    shikiTheme: "dark-slate",
    kind: "dark",
    windowBackground: "#2a2d35",
    titleBarSymbolColor: "#dde2e9",
    terminalBackground: "#1b1f27",
    terminalForeground: "#dde2e9",
  },
  {
    id: "dark-github",
    label: "GitHub",
    shikiTheme: "github-dark-default",
    kind: "dark",
    windowBackground: "#161b22",
    titleBarSymbolColor: "#7d8590",
    terminalBackground: "#0d1117",
    terminalForeground: "#e6edf3",
  },
  {
    id: "dark-intellij",
    label: "IntelliJ",
    shikiTheme: "dark-intellij",
    kind: "dark",
    windowBackground: "#2b2d30",
    titleBarSymbolColor: "#cccccc",
    terminalBackground: "#1e1f22",
    terminalForeground: "#bcbec3",
  },
  {
    id: "dark-dracula",
    label: "Dracula",
    shikiTheme: "dracula",
    kind: "dark",
    windowBackground: "#343746",
    titleBarSymbolColor: "#f8f8f2",
    terminalBackground: "#282a36",
    terminalForeground: "#f8f8f2",
  },
  {
    id: "dark-claude",
    label: "Claude",
    shikiTheme: "dark-claude",
    kind: "dark",
    windowBackground: "#2a2a2a",
    titleBarSymbolColor: "#c3c1ba",
    terminalBackground: "#151515",
    terminalForeground: "#c3c1ba",
  },
  {
    id: "light-modern",
    label: "VS Code",
    shikiTheme: "light-plus",
    kind: "light",
    windowBackground: "#f0f0f4",
    titleBarSymbolColor: "#606060",
    terminalBackground: "#ffffff",
    terminalForeground: "#3b3b3b",
  },
  {
    id: "light-github",
    label: "GitHub",
    shikiTheme: "github-light-default",
    kind: "light",
    windowBackground: "#f6f8fa",
    titleBarSymbolColor: "#656d76",
    terminalBackground: "#ffffff",
    terminalForeground: "#1f2328",
  },
  {
    id: "light-intellij",
    label: "IntelliJ",
    shikiTheme: "light-intellij",
    kind: "light",
    windowBackground: "#e9eaee",
    titleBarSymbolColor: "#000000",
    terminalBackground: "#ffffff",
    terminalForeground: "#080808",
  },
  {
    id: "light-claude",
    label: "Claude",
    shikiTheme: "light-claude",
    kind: "light",
    windowBackground: "#f0f0ec",
    titleBarSymbolColor: "#2a2a28",
    terminalBackground: "#fcfcfb",
    terminalForeground: "#2a2a28",
  },
];

export type ThemeKind = ThemeDefinition["kind"];

/** Each kind's theme before anyone picked one. */
export const DEFAULT_THEME_IDS: Readonly<Record<ThemeKind, string>> = { dark: "dark-modern", light: "light-modern" };

/** An unknown id, or one of the other kind, falls back to the default — as the keybinding preset. */
export function resolveTheme(id: string | undefined, kind?: ThemeKind): ThemeDefinition {
  return (
    THEMES.find((theme) => theme.id === id && (!kind || theme.kind === kind)) ??
    THEMES.find((theme) => theme.id === DEFAULT_THEME_IDS[kind ?? "dark"])!
  );
}

/** "system" is answered by the caller: `nativeTheme` in main, `prefers-color-scheme` in the window. */
export function schemeKind(scheme: ColorScheme, systemDark: boolean): ThemeKind {
  return scheme === "system" ? (systemDark ? "dark" : "light") : scheme;
}

/** Light or dark is chosen apart from the theme: `colorScheme` picks the kind, this key its theme. */
export function themeKey(kind: ThemeKind): "darkTheme" | "lightTheme" {
  return kind === "dark" ? "darkTheme" : "lightTheme";
}
