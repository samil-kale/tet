import { resolveTheme, themeKey } from "../shared/themes";
import type { RepositoryManager } from "./git/repository";
import type { SettingsAccess, SettingsStore } from "./store/settings";
import { currentTheme } from "./store/theme";
import type { SessionManagerRegistry } from "./terminals/session-registry";
import type { AppWindow } from "./window";

/** What a settings change is handed on to. */
export interface SettingsAccessDeps {
  settings: SettingsStore;
  window: Pick<AppWindow, "shownTheme" | "showTheme">;
  tabManagers: Pick<SessionManagerRegistry, "themeChanged" | "idleReminderChanged">;
  repositories: Pick<RepositoryManager, "announceFilesChanged">;
}

/**
 * Applies the saved theme live and returns whether a restart is still needed. Live only within one
 * `kind`: an agent gets light or dark once at tab start (`AgentPaths.theme`).
 */
function applyTheme({ settings, window, tabManagers }: SettingsAccessDeps): boolean {
  const shown = window.shownTheme();
  if (!shown) {
    return false;
  }
  // The kind on screen, not the saved one: a pending kind switch must not block a change within it.
  const { kind } = shown;
  window.showTheme(resolveTheme(settings.get().appearance[themeKey(kind)], kind));
  const saved = currentTheme(settings);
  // Agents get the saved theme (AgentPaths.theme), so only once it is on screen: a kind awaiting its
  // restart is not handed to them.
  if (saved.id === window.shownTheme()?.id) {
    tabManagers.themeChanged();
  }
  return saved.kind !== kind;
}

/** Every settings change, from the window or tet-ctl: stored, then handed on at once to what shows
 *  or reads it. */
export function settingsAccessOf(deps: SettingsAccessDeps): SettingsAccess {
  const { settings, tabManagers, repositories } = deps;
  return {
    get: () => settings.get(),
    patch(edits) {
      settings.patch(edits);
      const restartRequired = applyTheme(deps);
      if (edits.notifications?.idleReminder !== undefined) {
        tabManagers.idleReminderChanged();
      }
      if (
        edits.files?.excludeGitIgnore !== undefined ||
        edits.files?.compactFolders !== undefined ||
        edits.files?.sortOrder !== undefined
      ) {
        repositories.announceFilesChanged();
      }
      return restartRequired;
    },
  };
}
