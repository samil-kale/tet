import type { Suggester } from "./agents";

export const COLOR_SCHEMES = ["system", "light", "dark"] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** The lanes left of the tab area, in their order until the user moves one. */
export const LANES = ["projects", "git", "files"] as const;

export type Lane = (typeof LANES)[number];

/** Which lanes stand pinned, and one order for all of them: the pinned lanes in it, then the
 *  strip's toggles in it. */
export interface LaneSettings {
  pinned: Lane[];
  /** Every lane once. */
  order: Lane[];
}

/** The order split: the pinned lanes, then the strip's toggles; `laneSettings` joins them again. */
export function laneOrders(lanes: LaneSettings): { pinned: Lane[]; toggles: Lane[] } {
  return {
    pinned: lanes.order.filter((lane) => lanes.pinned.includes(lane)),
    toggles: lanes.order.filter((lane) => !lanes.pinned.includes(lane))
  };
}

/** `pinned` standing pinned in that order, then `toggles`. */
export function laneSettings(pinned: readonly Lane[], toggles: readonly Lane[]): LaneSettings {
  return { pinned: [...pinned], order: [...pinned, ...toggles] };
}

/** `lanes` with `lane` pinned at the end of the pinned ones, beside the free lane where it stood,
 *  or unpinned to the front of the toggles; one already so stays where it is. */
export function withLanePinned(lanes: LaneSettings, lane: Lane, pin: boolean): LaneSettings {
  if (lanes.pinned.includes(lane) === pin) {
    return lanes;
  }
  const others = (list: readonly Lane[]) => list.filter((entry) => entry !== lane);
  const { pinned, toggles } = laneOrders(lanes);
  return pin ? laneSettings([...others(pinned), lane], others(toggles)) : laneSettings(others(pinned), [lane, ...others(toggles)]);
}

/** The Appearance tab. */
export interface AppearanceSettings {
  /** "system" follows the OS. A window's kind is fixed when it is built (`applyTheme` in
   *  src/main/main.ts). */
  colorScheme: ColorScheme;
  /** Per kind, an id out of `THEMES` of that kind; applies at once while the window is that kind. */
  darkTheme: string;
  lightTheme: string;
  /** Set in the window alone (a header's menu, a drag) or by `tet-ctl`; written whole. */
  lanes: LaneSettings;
}

/** The Notifications tab: what every agent notifies the OS about. */
export interface NotificationSettings {
  /** The agent finished responding, with nothing it started still running. */
  finished: boolean;
  /** Blocked mid-turn on a permission prompt, an elicitation, or a question. */
  needsYou: boolean;
  /** Idle waiting for the next prompt; only Claude Code raises this event. */
  idleReminder: boolean;
}

export const NOTIFICATION_IDS = ["finished", "needsYou", "idleReminder"] as const satisfies readonly (keyof NotificationSettings)[];

/** The Files tab's part kept by tet; its Explorer view is the project's, in tet.json. */
export interface FilesSettings {
  /** An id out of `KEYBINDING_PRESETS`. */
  editorKeybindingPreset: string;
}

/** The Git tab: how git's checkboxes start out, each until the user ticks it otherwise. */
export interface GitSettings {
  /** A file LOCAL CHANGES has not listed before shows up checked, to be committed. */
  checkNewChanges: boolean;
  /** The commit question's "Also push". */
  pushOnCommit: boolean;
  /** "Also delete on the remote", when deleting a branch, a tag or a worktree. */
  deleteBranchOnRemote: boolean;
  deleteTagOnRemote: boolean;
  deleteWorktreeOnRemote: boolean;
}

/** What tet asks of an agent (prompts.ts), in the Prompts tab's picker. */
export const PROMPT_IDS = ["commitMessage", "handoff"] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

/** An empty string means tet's own (`DEFAULT_PROMPTS`). */
export type PromptTexts = Record<PromptId, string>;

/** The Prompts tab. */
export interface PromptSettings {
  texts: PromptTexts;
  /** Who suggests a commit message; an agent of "" until picked. */
  commitSuggester: Suggester;
}

/** What tet keeps about itself, not about a repository; written whole, one object per tab of the
 *  settings dialog that has values here (Environment keeps its own store, Info none). */
export interface AppSettings {
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
  files: FilesSettings;
  git: GitSettings;
  prompts: PromptSettings;
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
}

/** `edits` laid over `base`, by that rule. */
export function withSettings<T extends SettingsEdits>(base: T, edits: SettingsEdits): T {
  return {
    ...base,
    ...(edits.appearance && { appearance: { ...base.appearance, ...edits.appearance } }),
    ...(edits.notifications && { notifications: { ...base.notifications, ...edits.notifications } }),
    ...(edits.files && { files: { ...base.files, ...edits.files } }),
    ...(edits.git && { git: { ...base.git, ...edits.git } }),
    ...(edits.prompts && {
      prompts: {
        ...base.prompts,
        ...edits.prompts,
        ...(edits.prompts.texts && { texts: { ...base.prompts?.texts, ...edits.prompts.texts } })
      }
    })
  };
}

/** Shared so main and renderer cannot drift apart. */
export const DEFAULT_KEYBINDING_PRESET_ID = "vscode";
