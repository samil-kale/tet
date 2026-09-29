import type { Suggester } from "./agents";

/** What every agent notifies the OS about. */
export interface NotificationSettings {
  /** The agent finished responding, with nothing it started still running. */
  finished: boolean;
  /** Blocked mid-turn on a permission prompt, an elicitation, or a question. */
  needsYou: boolean;
  /** Idle waiting for the next prompt; only Claude Code raises this event. */
  idleReminder: boolean;
}

export const NOTIFICATION_IDS = ["finished", "needsYou", "idleReminder"] as const satisfies readonly (keyof NotificationSettings)[];

export const COLOR_SCHEMES = ["system", "light", "dark"] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** What tet keeps about itself, not about a repository; written whole. */
export interface AppSettings {
  notifications: NotificationSettings;
  /** An id out of `KEYBINDING_PRESETS`. */
  editorKeybindingPreset: string;
  /** "system" follows the OS. A window's kind is fixed when it is built (`applyTheme` in
   *  src/main/main.ts). */
  colorScheme: ColorScheme;
  /** Per kind, an id out of `THEMES` of that kind; applies at once while the window is that kind. */
  darkTheme: string;
  lightTheme: string;
  /** An empty string means tet's own (`DEFAULT_PROMPTS`). */
  prompts: PromptSettings;
  /** Who suggests a commit message, as last picked beside it; an agent of "" until picked. */
  commitSuggester: Suggester;
}

/** What tet asks of an agent (prompts.ts), in the Prompts tab's picker. */
export const PROMPT_IDS = ["commitMessage", "handoff"] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

export type PromptSettings = Record<PromptId, string>;

/**
 * A settings write: the keys it names and no others. The dialog and `tet-ctl` both write single
 * settings, and neither may take back what the other set meanwhile, so the two nested objects
 * merge by their own keys too — setting one prompt leaves the rest alone.
 */
export type SettingsEdits = Partial<Omit<AppSettings, "notifications" | "prompts">> & {
  notifications?: Partial<NotificationSettings>;
  prompts?: Partial<PromptSettings>;
};

/** `edits` laid over `base`, by that rule. */
export function withSettings<T extends SettingsEdits>(base: T, edits: SettingsEdits): T {
  return {
    ...base,
    ...edits,
    ...(edits.notifications && { notifications: { ...base.notifications, ...edits.notifications } }),
    ...(edits.prompts && { prompts: { ...base.prompts, ...edits.prompts } })
  };
}

/** Shared so main and renderer cannot drift apart. */
export const DEFAULT_KEYBINDING_PRESET_ID = "vscode";
