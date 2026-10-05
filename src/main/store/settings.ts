import * as path from "node:path";
import { DEFAULT_THEME_IDS, type ThemeKind } from "../../shared/themes";
import { DEFAULT_PROMPTS } from "../../shared/prompts";
import { EXPLORER_SORT_ORDERS } from "../../shared/types/files";
import { COLOR_SCHEMES, DEFAULT_KEYBINDING_PRESET_ID, LANES, PROMPT_IDS, withSettings } from "../../shared/types/settings";
import type { Suggester } from "../../shared/types/agents";
import type {
  AppearanceSettings,
  AppSettings,
  FilesSettings,
  Lane,
  LaneSettings,
  PromptSettings,
  PromptTexts,
  SettingsEdits,
} from "../../shared/types/settings";
import { isRecord, readJson, writeJson } from "../util/json-file";

const DEFAULTS: AppSettings = {
  appearance: {
    colorScheme: "system",
    darkTheme: DEFAULT_THEME_IDS.dark,
    lightTheme: DEFAULT_THEME_IDS.light,
    lanes: LANES.map((lane) => ({ lane, pinned: lane === "projects" })),
  },
  notifications: {
    finished: true,
    waiting: true,
    idleReminder: false,
  },
  files: {
    editorKeybindingPreset: DEFAULT_KEYBINDING_PRESET_ID,
    excludeGitIgnore: false,
    compactFolders: true,
    sortOrder: "default",
  },
  git: {
    checkNewChanges: false,
    pushOnCommit: false,
    deleteBranchOnRemote: false,
    deleteTagOnRemote: false,
    deleteWorktreeOnRemote: false,
  },
  prompts: {
    texts: Object.fromEntries(PROMPT_IDS.map((id) => [id, ""])) as PromptTexts,
    commitSuggester: { agentId: "", model: "" },
  },
};

/** Reading and editing the settings, all either transport does with them: both take this rather
 *  than the store, so a change from `settings-set-*` reaches everything a change from the window's
 *  `settings:patch` does (main.ts). `patch` returns whether a restart is still needed. */
export interface SettingsAccess {
  get(): AppSettings;
  patch(edits: SettingsEdits): boolean;
}

/**
 * The settings dialog's values in TET's data folder (data-root.ts). Written whole, read back
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
    files: files(record(value.files)),
    git: switches(record(value.git), DEFAULTS.git),
    prompts: prompts(record(value.prompts)),
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
    lanes: lanes(value.lanes),
  };
}

/** What isn't a list is the default; in one, what names no lane and a lane named twice drop out,
 *  a lane it misses is added at its end, unpinned. */
function lanes(value: unknown): LaneSettings {
  if (!Array.isArray(value)) {
    return DEFAULTS.appearance.lanes;
  }
  const entries: LaneSettings = [];
  for (const item of value) {
    const entry = record(item);
    if (LANES.includes(entry.lane as Lane) && !entries.some((kept) => kept.lane === entry.lane)) {
      entries.push({ lane: entry.lane as Lane, pinned: entry.pinned === true });
    }
  }
  return [...entries, ...LANES.filter((lane) => !entries.some((kept) => kept.lane === lane)).map((lane) => ({ lane, pinned: false }))];
}

/** A switch that isn't a boolean in the file takes its default. */
function switches<T extends object>(value: Record<string, unknown>, defaults: T): T {
  return Object.fromEntries(
    Object.entries(defaults).map(([id, fallback]) => [id, typeof value[id] === "boolean" ? value[id] : fallback]),
  ) as T;
}

function files(value: Record<string, unknown>): FilesSettings {
  const { excludeGitIgnore, compactFolders } = switches(value, {
    excludeGitIgnore: DEFAULTS.files.excludeGitIgnore,
    compactFolders: DEFAULTS.files.compactFolders,
  });
  return {
    editorKeybindingPreset: presetId(value.editorKeybindingPreset),
    excludeGitIgnore,
    compactFolders,
    sortOrder: EXPLORER_SORT_ORDERS.find((order) => order === value.sortOrder) ?? DEFAULTS.files.sortOrder,
  };
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
 * A non-string, or TET's own default text verbatim, is stored as "", so a later improved default
 * still reaches the user (`effectivePrompt` fills it in).
 */
function promptTexts(texts: Record<string, unknown>): PromptTexts {
  return Object.fromEntries(
    PROMPT_IDS.map((id) => {
      const text = texts[id];
      return [id, typeof text === "string" && text !== DEFAULT_PROMPTS[id] ? text : ""];
    }),
  ) as PromptTexts;
}
