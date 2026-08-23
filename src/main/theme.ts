import { nativeTheme } from "electron";
import { resolveTheme, SYSTEM_THEME_ID, type ThemeDefinition } from "../shared/themes";
import type { SettingsStore } from "./settings";

/**
 * The theme the settings name, with "system" answered by the OS — `nativeTheme` is
 * Electron's view of its light/dark mode on all three platforms. Asked whenever a window or
 * an agent is prepared, not once at startup: a switch of the OS mode reaches what is opened
 * after it, like every other change to this setting, and nothing already up (see CLAUDE.md on
 * why a theme applies after a restart).
 */
export function currentTheme(settings: SettingsStore): ThemeDefinition {
  const id = settings.get().theme;
  if (id === SYSTEM_THEME_ID) {
    return resolveTheme(nativeTheme.shouldUseDarkColors ? "dark-modern" : "light-modern");
  }
  return resolveTheme(id);
}
