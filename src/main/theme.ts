import { nativeTheme } from "electron";
import { resolveTheme, schemeKind, themeKey, type ThemeDefinition } from "../shared/themes";
import type { SettingsStore } from "./settings";

/** The saved theme for the kind in use, "system" answered by `nativeTheme`. Asked per window and
 *  agent, so a change reaches what opens later; the running window only via main.ts's `applyTheme`. */
export function currentTheme(settings: SettingsStore): ThemeDefinition {
  const current = settings.get();
  const kind = schemeKind(current.colorScheme, nativeTheme.shouldUseDarkColors);
  return resolveTheme(current[themeKey(kind)], kind);
}
