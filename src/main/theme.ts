import { nativeTheme } from "electron";
import { resolveTheme, schemeKind, themeKey, type ThemeDefinition } from "../shared/themes";
import type { SettingsStore } from "./settings";

/** The theme the settings name for the kind in use, with "system" answered by the OS
 *  (`nativeTheme`, Electron's view of light/dark mode on all three platforms). Asked whenever a
 *  window or an agent is prepared, not once at startup: a change reaches what is opened after it,
 *  and the window already up only through `applyTheme` in main.ts. */
export function currentTheme(settings: SettingsStore): ThemeDefinition {
  const current = settings.get();
  const kind = schemeKind(current.colorScheme, nativeTheme.shouldUseDarkColors);
  return resolveTheme(current[themeKey(kind)], kind);
}
