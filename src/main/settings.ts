import * as path from "node:path";
import { DEFAULT_THEME_IDS, THEMES, type ThemeKind } from "../shared/themes";
import { DEFAULT_PROMPTS } from "../shared/prompts";
import { COLOR_SCHEMES, DEFAULT_KEYBINDING_PRESET_ID, PROMPT_IDS, withSettings } from "../shared/types";
import type { AppSettings, ColorScheme, PromptSettings, SettingsEdits } from "../shared/types";
import { isRecord, readJson, saveJson } from "./json-file";

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

/** Reading and editing the settings, all either transport does with them: `ControlDeps` takes
 *  this rather than the store, so `settings-get` and `settings-set` answer for the same contract
 *  the window's `settings:get`/`settings:patch` do. */
export interface SettingsAccess {
  get(): AppSettings;
  patch(edits: SettingsEdits): void;
}

/**
 * The settings dialog's values in tet's data folder (data-root.ts). Written whole, read back
 * defensively: a key of the wrong type falls back to its default rather than reaching an agent as
 * `undefined`.
 */
export class SettingsStore implements SettingsAccess {
  private readonly file: string;
  private settings: AppSettings = DEFAULTS;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "settings.json");
    this.load();
  }

  get(): AppSettings {
    return this.settings;
  }

  /**
   * Writes the settings `edits` names and leaves the rest as stored. The single place the merge
   * happens: a caller that read, changed and wrote the whole thing would take back whatever was
   * set between its read and its write.
   */
  patch(edits: SettingsEdits): void {
    this.save(withSettings(this.settings, edits));
  }

  private save(settings: AppSettings): void {
    this.settings = normalize(settings);
    // Renamed into place: `load` reads a half-written file as the defaults.
    saveJson(this.file, this.settings, "settings");
  }

  private load(): void {
    const parsed = readJson(this.file);
    if (isRecord(parsed)) {
      this.settings = normalize(parsed as Partial<AppSettings>);
    }
  }
}

/** A single theme setting in the file: one theme id, or "system". */
interface LegacyThemeSetting {
  theme?: unknown;
}

/** Every key as the store holds it, from the dialog or the file. */
function normalize(value: Partial<AppSettings> & LegacyThemeSetting): AppSettings {
  // A single theme setting becomes its kind and that kind's theme; "system" or an unknown id
  // does not.
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

/** A switch that isn't a boolean in the file takes its default. */
function booleans(notifications: Partial<AppSettings["notifications"]> | undefined): AppSettings["notifications"] {
  const defaults = DEFAULTS.notifications;
  return {
    finished: typeof notifications?.finished === "boolean" ? notifications.finished : defaults.finished,
    needsYou: typeof notifications?.needsYou === "boolean" ? notifications.needsYou : defaults.needsYou,
    idleReminder:
      typeof notifications?.idleReminder === "boolean" ? notifications.idleReminder : defaults.idleReminder
  };
}

/** A non-string is the default; an unknown id is kept — the renderer falls back to VS Code's
 *  bindings for it. */
function presetId(value: unknown): string {
  return typeof value === "string" && value ? value : DEFAULTS.editorKeybindingPreset;
}

/** Likewise for a kind's theme: an unknown id is kept, and `currentTheme` falls back. */
function themeId(value: unknown, kind: ThemeKind): string {
  return typeof value === "string" && value ? value : DEFAULT_THEME_IDS[kind];
}

/**
 * A non-string, or tet's own default text verbatim, is stored as "", so a later improved default
 * still reaches the user (`effectivePrompt` fills it in).
 */
function promptTexts(value: unknown): PromptSettings {
  const texts: Partial<Record<string, unknown>> = isRecord(value) ? value : {};
  return Object.fromEntries(
    PROMPT_IDS.map((id) => {
      const text = texts[id];
      return [id, typeof text === "string" && text !== DEFAULT_PROMPTS[id] ? text : ""];
    })
  ) as PromptSettings;
}
