import type { SuggesterEntry } from "./agents";
import type { ExplorerSettings } from "./files";

export const COLOR_SCHEMES = ["system", "light", "dark"] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** The lanes left of the tab area, in their fixed order. */
export const LANES = ["projects", "git", "files", "issues", "change-requests", "archive"] as const;

export type Lane = (typeof LANES)[number];

/** The Appearance tab. */
export interface AppearanceSettings {
  /** "system" follows the OS. A window's kind is fixed when it is built (`applyTheme` in
   *  src/main/main.ts). */
  colorScheme: ColorScheme;
  /** Per kind, an id out of `THEMES` of that kind; applies at once while the window is that kind. */
  darkTheme: string;
  lightTheme: string;
}

/** The Notifications tab: what every agent notifies the OS about. */
export interface NotificationSettings {
  /** The agent finished responding, with nothing it started still running. */
  finished: boolean;
  /** Blocked mid-turn on a permission prompt, an elicitation, or a question. */
  waiting: boolean;
  /** Idle waiting for the next prompt; only Claude Code raises this event. */
  idleReminder: boolean;
  /** A notice in the window: a change request opened, or made ready, by someone else. */
  changeRequestOpened: boolean;
  /** A notice in the window: the checks of a change request of the account failed. */
  changeRequestFailed: boolean;
}

export const NOTIFICATION_IDS = [
  "finished",
  "waiting",
  "idleReminder",
  "changeRequestOpened",
  "changeRequestFailed",
] as const satisfies readonly (keyof NotificationSettings)[];

/** The Files tab: how the Explorer lists every project (its folders and excludes are the project's,
 *  in tet.json) and the file editor. */
export interface FilesSettings extends ExplorerSettings {
  /** An id out of `KEYBINDING_PRESETS`. */
  editorKeybindingPreset: string;
}

/** The Git tab: how git's checkboxes start out, each until the user ticks it otherwise. */
export interface GitSettings {
  /** A file Local Changes has not listed before shows up checked, to be committed. */
  checkNewChanges: boolean;
  /** The commit question's "Also push". */
  pushOnCommit: boolean;
  /** The rename question's "Also rename on the remote". */
  renameBranchOnRemote: boolean;
  /** "Also delete on the remote", when deleting a branch, a tag or a worktree. */
  deleteBranchOnRemote: boolean;
  deleteTagOnRemote: boolean;
  deleteWorktreeOnRemote: boolean;
  /** The pull or merge request question's "Approve on creation", where the host lets its author. */
  approveChangeRequest: boolean;
  /** Its "Set to auto-merge". */
  autoMergeChangeRequest: boolean;
  /** Its "Squash on auto-merge". */
  squashChangeRequest: boolean;
  /** Its "Open as draft". */
  draftChangeRequest: boolean;
  /** Its "Delete source branch", where the host can. */
  deleteSourceBranchChangeRequest: boolean;
}

export const GIT_SETTING_IDS = [
  "checkNewChanges",
  "pushOnCommit",
  "renameBranchOnRemote",
  "deleteBranchOnRemote",
  "deleteTagOnRemote",
  "deleteWorktreeOnRemote",
  "approveChangeRequest",
  "autoMergeChangeRequest",
  "squashChangeRequest",
  "draftChangeRequest",
  "deleteSourceBranchChangeRequest",
] as const satisfies readonly (keyof GitSettings)[];

/** What TET asks of an agent (prompts.ts), in the Prompts tab's picker. */
export const PROMPT_IDS = ["commitMessage", "handover", "issue", "changeRequest", "changeRequestTab"] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

/** An empty string means TET's own (`DEFAULT_PROMPTS`). */
export type PromptTexts = Record<PromptId, string>;

/** The Prompts tab. */
export interface PromptSettings {
  texts: PromptTexts;
  /** Who suggests a commit message and a pull or merge request's text, in the order they are asked;
   *  an agent not listed comes after, switched on (`suggestersFor`). */
  commitSuggesters: SuggesterEntry[];
}

/** The Environment tab; its variables have a store of their own (store/environment.ts). */
export interface EnvironmentSettings {
  /** The values lie encrypted by the OS; unticked, in the clear, for a file shared between machines. */
  encryptValues: boolean;
}

/** What TET keeps about itself, not about a repository; written whole, one object per tab of the
 *  settings dialog that has values here (Info has none). A new setting
 *  joins its tab's object, never the top level. The dialog holds no setting of a project: those are
 *  tet.json's, edited where they show. `normalize` (store/settings.ts) reads every key back
 *  defensively, with its default. */
export interface AppSettings {
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
  files: FilesSettings;
  git: GitSettings;
  prompts: PromptSettings;
  environment: EnvironmentSettings;
}

/**
 * A settings write: the keys it names and no others. The dialog and `tet-ctl` both write single
 * settings, and neither may take back what the other set meanwhile, so each tab's object merges by
 * its own keys too, the prompt texts within it as well — setting one prompt leaves the rest alone.
 */
export interface SettingsEdits {
  appearance?: Partial<AppearanceSettings>;
  notifications?: Partial<NotificationSettings>;
  files?: Partial<FilesSettings>;
  git?: Partial<GitSettings>;
  prompts?: Partial<Omit<PromptSettings, "texts">> & { texts?: Partial<PromptTexts> };
  environment?: Partial<EnvironmentSettings>;
}

/** `edits` laid over `base`, by that rule. */
export function withSettings<T extends SettingsEdits>(base: T, edits: SettingsEdits): T {
  return {
    ...base,
    ...(edits.appearance && { appearance: { ...base.appearance, ...edits.appearance } }),
    ...(edits.notifications && { notifications: { ...base.notifications, ...edits.notifications } }),
    ...(edits.files && { files: { ...base.files, ...edits.files } }),
    ...(edits.git && { git: { ...base.git, ...edits.git } }),
    ...(edits.environment && { environment: { ...base.environment, ...edits.environment } }),
    ...(edits.prompts && {
      prompts: {
        ...base.prompts,
        ...edits.prompts,
        ...(edits.prompts.texts && { texts: { ...base.prompts?.texts, ...edits.prompts.texts } }),
      },
    }),
  };
}

/** Shared so main and renderer cannot drift apart. */
export const DEFAULT_KEYBINDING_PRESET_ID = "vscode";
