import { nativeTheme } from "electron";
import { resolveTheme, SYSTEM_THEME_ID, type ThemeDefinition } from "../shared/themes";
import type { SettingsStore } from "./settings";

/** The theme the settings name, with "system" answered by the OS (`nativeTheme`, Electron's view
 *  of light/dark mode on all three platforms). Asked whenever a window or an agent is prepared,
 *  not once at startup: a change reaches what is opened after it, nothing already up. */
export function currentTheme(settings: SettingsStore): ThemeDefinition {
  const id = settings.get().theme;
  if (id === SYSTEM_THEME_ID) {
    return resolveTheme(nativeTheme.shouldUseDarkColors ? "dark-modern" : "light-modern");
  }
  return resolveTheme(id);
}
