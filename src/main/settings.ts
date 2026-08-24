import * as fs from "node:fs";
import * as path from "node:path";
import { SYSTEM_THEME_ID } from "../shared/themes";
import { DEFAULT_KEYBINDING_PRESET_ID, THEMED_AGENT_IDS } from "../shared/types";
import type { AppSettings, ThemeAgentSettings } from "../shared/types";

/** What tet does before anyone has said otherwise; sbc's own defaults. */
const DEFAULTS: AppSettings = {
  notifications: {
    finished: true,
    needsYou: true,
    idleReminder: false
  },
  editorKeybindingPreset: DEFAULT_KEYBINDING_PRESET_ID,
  theme: SYSTEM_THEME_ID,
  themeAgents: Object.fromEntries(THEMED_AGENT_IDS.map((id) => [id, true])) as ThemeAgentSettings
};

/**
 * The settings dialog's values, persisted in tet's own userData. Written whole from memory
 * like the projects next to it, and read back defensively: a file someone edited by hand is
 * still a file, so a key of the wrong type falls back to its default rather than reaching an
 * agent as `undefined`.
 */
export class SettingsStore {
  private readonly file: string;
  private settings: AppSettings = DEFAULTS;

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, "settings.json");
    this.load();
  }

  get(): AppSettings {
    return this.settings;
  }

  save(settings: AppSettings): void {
    this.settings = {
      notifications: booleans(settings.notifications),
      editorKeybindingPreset: presetId(settings.editorKeybindingPreset),
      theme: themeId(settings.theme),
      themeAgents: agentFlags(settings.themeAgents)
    };
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2), "utf8");
    } catch (error) {
      console.error("[tet] could not persist settings:", error);
    }
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        const value = parsed as Partial<AppSettings>;
        this.settings = {
          notifications: booleans(value.notifications),
          editorKeybindingPreset: presetId(value.editorKeybindingPreset),
          theme: themeId(value.theme),
          themeAgents: agentFlags(value.themeAgents)
        };
      }
    } catch {
      // No file yet (first start) or unreadable — the defaults stand.
      this.settings = DEFAULTS;
    }
  }
}

/** Every switch that is not a boolean in the file is the one the defaults name. */
function booleans(notifications: Partial<AppSettings["notifications"]> | undefined): AppSettings["notifications"] {
  const defaults = DEFAULTS.notifications;
  return {
    finished: typeof notifications?.finished === "boolean" ? notifications.finished : defaults.finished,
    needsYou: typeof notifications?.needsYou === "boolean" ? notifications.needsYou : defaults.needsYou,
    idleReminder:
      typeof notifications?.idleReminder === "boolean" ? notifications.idleReminder : defaults.idleReminder
  };
}

/** Not a string in the file is the default; an id the current presets no longer know is left
 *  as it is — the renderer's own lookup falls back to VS Code's bindings for one it doesn't
 *  recognise, same as it would for an id this store had never heard of either. */
function presetId(value: unknown): string {
  return typeof value === "string" && value ? value : DEFAULTS.editorKeybindingPreset;
}

/** The same contract for the theme: an unknown id is left standing, and every reader of it
 *  (`currentTheme`, which also answers "system") falls back to the default on its own. */
function themeId(value: unknown): string {
  return typeof value === "string" && value ? value : DEFAULTS.theme;
}

/** One switch per agent, read the way the notifications are. */
function agentFlags(value: unknown): ThemeAgentSettings {
  const flags = (typeof value === "object" && value !== null ? value : {}) as Partial<Record<string, unknown>>;
  const defaults = DEFAULTS.themeAgents;
  return Object.fromEntries(
    THEMED_AGENT_IDS.map((id) => {
      const flag = flags[id];
      return [id, typeof flag === "boolean" ? flag : defaults[id]];
    })
  ) as ThemeAgentSettings;
}
