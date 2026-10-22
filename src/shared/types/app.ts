import type { TabRef } from "./terminals";

/** The settings dialog's Info tab, read once. */
export interface AppInfo {
  /** package.json's version. */
  version: string;
  electron: string;
  chromium: string;
  node: string;
  /** `PLATFORM.id` and `process.arch`. */
  os: string;
}

/** Decides how long a notice stands (Notices.tsx). */
export const NOTICE_SEVERITIES = ["error", "warning", "info"] as const;

export type NoticeSeverity = (typeof NOTICE_SEVERITIES)[number];

/** Which tab mark a notice shows in place of its severity's icon: the turn state it reports. */
export type NoticeMark = "waiting" | "finished" | "working";

/** Where a turn's notice says its tab is: the repository or worktree, then the tab's title, which
 *  tells two tabs of one agent apart. */
export function noticePlace(placeName: string, tabTitle: string): string {
  return tabTitle ? `${placeName} - ${tabTitle}` : placeName;
}

/** A notice the window showed, reported for `tet-ctl notices-list`. */
export interface NoticeReport extends Notice {
  /** ms since epoch. */
  at: number;
}

/** An editor tab's state, reported by the renderer (where the editor alone lives) on every
 *  snapshot change, for `tet-ctl editor-get` and `editor-list`. Without the text, which may be
 *  large and changes several times per write on disk. Which tab is active is reported apart, by
 *  the window's layout. */
export interface EditorReport {
  path: string;
  /** The read of `path` still in flight. */
  loading: boolean;
  dirty: boolean;
  readOnly: boolean;
  /** Why the file could not be read. */
  error?: string;
  /** The tab the next file opened replaces. */
  preview: boolean;
}

/** `editor-list`'s entry: the report plus whether it is the project's active editor tab. */
export interface EditorListing extends EditorReport {
  active: boolean;
}

/** Anything the user is told — not a *status*, which a view draws itself. */
export interface Notice {
  severity: NoticeSeverity;
  message: string;
  /** `false`: listed in the notification center only, as the desktop already shows it. */
  toast?: false;
  /** The tab a click on its entry shows. */
  target?: TabRef;
  mark?: NoticeMark;
}

/** A download's notice, updated in place by its `key` (Notices.tsx's `showProgress`). */
export interface NoticeProgress {
  key: string;
  message: string;
  /** Share done, 0 to 1, `null` while unknown (a running bar); `undefined` ends it, its notice goes. */
  fraction: number | null | undefined;
  /** With `fraction: undefined`: the notice stays in its place as the info `message`, its bar gone. */
  done?: boolean;
}
