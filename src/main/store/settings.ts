import * as path from "node:path";
import { DEFAULT_THEME_IDS, type ThemeKind } from "../../shared/themes";
import { DEFAULT_PROMPTS } from "../../shared/prompts";
import { COLOR_SCHEMES, DEFAULT_KEYBINDING_PRESET_ID, LANES, PROMPT_IDS, withSettings } from "../../shared/types/settings";
import type { Suggester } from "../../shared/types/agents";
import type { AppearanceSettings, AppSettings, Lane, LaneSettings, PromptSettings, PromptTexts, SettingsEdits } from "../../shared/types/settings";
import { isRecord, readJson, writeJson } from "../util/json-file";

const DEFAULTS: AppSettings = {
  appearance: {
    colorScheme: "system",
    darkTheme: DEFAULT_THEME_IDS.dark,
    lightTheme: DEFAULT_THEME_IDS.light,
    lanes: { pinned: ["projects"], order: [...LANES] }
  },
  notifications: {
    finished: true,
    needsYou: true,
    idleReminder: false
  },
  files: {
    editorKeybindingPreset: DEFAULT_KEYBINDING_PRESET_ID
  },
  git: {
    checkNewChanges: false,
    pushOnCommit: false,
    deleteBranchOnRemote: false,
    deleteTagOnRemote: false,
    deleteWorktreeOnRemote: false
  },
  prompts: {
    texts: Object.fromEntries(PROMPT_IDS.map((id) => [id, ""])) as PromptTexts,
    commitSuggester: { agentId: "", model: "" }
  }
};

/** Reading and editing the settings, all either transport does with them: both take this rather
 *  than the store, so a change from `settings-set-*` reaches everything a change from the window's
 *  `settings:patch` does (main.ts). `patch` returns whether a restart is still needed. */
export interface SettingsAccess {
  get(): AppSettings;
  patch(edits: SettingsEdits): boolean;
}

/**
 * The settings dialog's values in tet's data folder (data-root.ts). Written whole, read back
 * defensively: a key of the wrong type falls back to its default rather than reaching an agent as
 * `undefined`.
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

  /**
   * Writes the settings `edits` names and leaves the rest as stored. The single place the merge
   * happens: a caller that read, changed and wrote the whole thing would take back whatever was
   * set between its read and its write. Throws when the file cannot be written, nothing changed.
   */
  patch(edits: SettingsEdits): void {
    this.save(withSettings(this.settings, edits));
  }

  private save(settings: AppSettings): void {
    const next = normalize(settings);
    // Renamed into place: `load` reads a half-written file as the defaults.
    writeJson(this.file, next);
    this.settings = next;
  }

  private load(): void {
    const parsed = readJson(this.file);
    if (isRecord(parsed)) {
      this.settings = normalize(parsed);
    }
  }
}

/** Every key as the store holds it, from the dialog or the file; a tab's object that isn't one
 *  takes its defaults whole. */
function normalize(stored: unknown): AppSettings {
  const value = record(stored);
  return {
    appearance: appearance(record(value.appearance)),
    notifications: switches(record(value.notifications), DEFAULTS.notifications),
    files: { editorKeybindingPreset: presetId(record(value.files).editorKeybindingPreset) },
    git: switches(record(value.git), DEFAULTS.git),
    prompts: prompts(record(value.prompts))
  };
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function appearance(value: Record<string, unknown>): AppearanceSettings {
  return {
    colorScheme: COLOR_SCHEMES.find((scheme) => scheme === value.colorScheme) ?? DEFAULTS.appearance.colorScheme,
    darkTheme: themeId(value.darkTheme, "dark"),
    lightTheme: themeId(value.lightTheme, "light"),
    lanes: lanes(record(value.lanes))
  };
}

/** A list that isn't one is the default; in one, what names no lane and a lane named twice drop
 *  out, and the order takes a lane it misses at its end. */
function lanes(value: Record<string, unknown>): LaneSettings {
  const known = (list: unknown): Lane[] | undefined =>
    Array.isArray(list) ? [...new Set(list)].filter((entry): entry is Lane => LANES.includes(entry as Lane)) : undefined;
  const order = known(value.order) ?? DEFAULTS.appearance.lanes.order;
  return {
    pinned: known(value.pinned) ?? DEFAULTS.appearance.lanes.pinned,
    order: [...order, ...LANES.filter((lane) => !order.includes(lane))]
  };
}

/** A switch that isn't a boolean in the file takes its default. */
function switches<T extends object>(value: Record<string, unknown>, defaults: T): T {
  return Object.fromEntries(
    Object.entries(defaults).map(([id, fallback]) => [id, typeof value[id] === "boolean" ? value[id] : fallback])
  ) as T;
}

/** A non-string is the default; an unknown id is kept — the renderer falls back to VS Code's
 *  bindings for it. */
function presetId(value: unknown): string {
  return typeof value === "string" && value ? value : DEFAULTS.files.editorKeybindingPreset;
}

/** Likewise for a kind's theme: an unknown id is kept, and `currentTheme` falls back. */
function themeId(value: unknown, kind: ThemeKind): string {
  return typeof value === "string" && value ? value : DEFAULT_THEME_IDS[kind];
}

function prompts(value: Record<string, unknown>): PromptSettings {
  return { texts: promptTexts(record(value.texts)), commitSuggester: suggester(value.commitSuggester) };
}

/** Anything but two strings is no pick; an agent or model no longer offered is replaced where it
 *  is used (`SuggesterPicker`, `repository:suggest-commit-message`). */
function suggester(value: unknown): Suggester {
  if (isRecord(value) && typeof value.agentId === "string" && typeof value.model === "string") {
    return { agentId: value.agentId, model: value.model };
  }
  return DEFAULTS.prompts.commitSuggester;
}

/**
 * A non-string, or tet's own default text verbatim, is stored as "", so a later improved default
 * still reaches the user (`effectivePrompt` fills it in).
 */
function promptTexts(texts: Record<string, unknown>): PromptTexts {
  return Object.fromEntries(
    PROMPT_IDS.map((id) => {
      const text = texts[id];
      return [id, typeof text === "string" && text !== DEFAULT_PROMPTS[id] ? text : ""];
    })
  ) as PromptTexts;
}
