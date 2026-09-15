import { nativeTheme } from "electron";
import { resolveTheme, type ThemeDefinition } from "../shared/themes";
import type { SettingsStore } from "./settings";

/** The theme the settings name for the kind in use, with "system" answered by the OS
 *  (`nativeTheme`, Electron's view of light/dark mode on all three platforms). Asked whenever a
 *  window or an agent is prepared, not once at startup: a change reaches what is opened after it,
 *  and the window already up only through `applyTheme` in main.ts. */
export function currentTheme(settings: SettingsStore): ThemeDefinition {
  const { colorScheme, darkTheme, lightTheme } = settings.get();
  const kind = colorScheme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : colorScheme;
  return resolveTheme(kind === "dark" ? darkTheme : lightTheme, kind);
}
