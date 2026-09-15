import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_THEME_IDS, THEMES, type ThemeKind } from "../shared/themes";
import { DEFAULT_PROMPTS } from "../shared/prompts";
import { COLOR_SCHEMES, DEFAULT_KEYBINDING_PRESET_ID, PROMPT_IDS } from "../shared/types";
import type { AppSettings, ColorScheme, PromptSettings } from "../shared/types";

/** What tet does before anyone has said otherwise; tet's own defaults. */
const DEFAULTS: AppSettings = {
  notifications: {
    finished: true,
    needsYou: true,
    idleReminder: false
  },
  editorKeybindingPreset: DEFAULT_KEYBINDING_PRESET_ID,
  colorScheme: "system",
  darkTheme: DEFAULT_THEME_IDS.dark,
  lightTheme: DEFAULT_THEME_IDS.light,
  prompts: Object.fromEntries(PROMPT_IDS.map((id) => [id, ""])) as PromptSettings
};

/**
 * The settings dialog's values, persisted in tet's data folder (data-root.ts). Written whole from memory and
 * read back defensively: a key of the wrong type falls back to its default rather than reaching
 * an agent as `undefined`.
 */
export class SettingsStore {
  private readonly file: string;
  private settings: AppSettings = DEFAULTS;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "settings.json");
    this.load();
  }

  get(): AppSettings {
    return this.settings;
  }

  save(settings: AppSettings): void {
    this.settings = normalize(settings);
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
        this.settings = normalize(parsed as Partial<AppSettings>);
      }
    } catch {
      // No file yet (first start) or unreadable — the defaults stand.
      this.settings = DEFAULTS;
    }
  }
}

/** What a file written before light and dark were chosen apart held: one theme id, or "system". */
interface LegacyThemeSetting {
  theme?: unknown;
}

/** Every key as the store holds it, whether it came from the dialog or from the file. */
function normalize(value: Partial<AppSettings> & LegacyThemeSetting): AppSettings {
  // The one theme an older file names becomes its kind and that kind's theme; "system" or an
  // unknown id leaves the defaults.
  const legacy = THEMES.find((theme) => theme.id === value.theme);
  return {
    notifications: booleans(value.notifications),
    editorKeybindingPreset: presetId(value.editorKeybindingPreset),
    colorScheme: colorScheme(value.colorScheme ?? legacy?.kind),
    darkTheme: themeId(value.darkTheme ?? (legacy?.kind === "dark" ? legacy.id : undefined), "dark"),
    lightTheme: themeId(value.lightTheme ?? (legacy?.kind === "light" ? legacy.id : undefined), "light"),
    prompts: promptTexts(value.prompts)
  };
}

function colorScheme(value: unknown): ColorScheme {
  return COLOR_SCHEMES.find((scheme) => scheme === value) ?? DEFAULTS.colorScheme;
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

/** Not a string in the file is the default; an id the current presets no longer know is left as it
 *  is — the renderer's own lookup falls back to VS Code's bindings for one it doesn't recognise. */
function presetId(value: unknown): string {
  return typeof value === "string" && value ? value : DEFAULTS.editorKeybindingPreset;
}

/** The same for a kind's theme: an unknown id is left standing, and `currentTheme` falls back. */
function themeId(value: unknown, kind: ThemeKind): string {
  return typeof value === "string" && value ? value : DEFAULT_THEME_IDS[kind];
}

/**
 * One text for the question. Not a string is the default, and so is tet's own text spelled out in
 * full — stored as "" instead, so a default improved in a later version still reaches the user
 * (`effectivePrompt` fills it back in).
 */
function promptTexts(value: unknown): PromptSettings {
  const texts = (typeof value === "object" && value !== null ? value : {}) as Partial<Record<string, unknown>>;
  return Object.fromEntries(
    PROMPT_IDS.map((id) => {
      const text = texts[id];
      return [id, typeof text === "string" && text !== DEFAULT_PROMPTS[id] ? text : ""];
    })
  ) as PromptSettings;
}
