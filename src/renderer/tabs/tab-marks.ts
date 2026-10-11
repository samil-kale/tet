import { isWorking } from "../../shared/types/terminals";
import type { TabDescriptor } from "../../shared/types/terminals";
import { sameList } from "../identity";

/** A repository's or worktree's marked sessions by tab id, oldest first: finished out of sight,
 *  waiting on an answer, and starting (so the pane a new agent opens in shows the bar,
 *  `TabArea`'s `startingHere`). `working` excludes a session stopped on a question. Decided in
 *  `useTabMarks`, against what is on screen. */
export interface RefMarks {
  finished: string[];
  waiting: string[];
  starting: string[];
  working: boolean;
}

/** Shared instance, so a pane's props stay identical for a project with none. */
export const NO_IDS: string[] = [];

/** The two marks main holds per tab, as the time it was set. */
export type MarkField = "finishedAt" | "waitingAt";

/**
 * Finished or waiting sessions not on screen, oldest first — the tab strip's marks and
 * what the project row steps through. Tabs on screen are left out: nothing there was out of sight.
 * Decided here, once: main holds the mark but cannot see the screen, and two views must not each
 * decide.
 */
export function markedTabs(tabs: readonly TabDescriptor[], field: MarkField, onScreen: readonly string[]): TabDescriptor[] {
  return tabs.filter((tab) => tab[field] !== undefined && !onScreen.includes(tab.tabId)).sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
}

/**
 * The above as tab ids plus `working` (`RefMarks`) for one repository or worktree, identity-stable
 * where unchanged against its `previous`: panes and the project list take them as props, and most
 * pushes change nothing here. `working` includes the tab on screen (a spinner is about now) but not
 * one waiting on a question: that session is not working, and both marks would stand side by side.
 */
export function refMarks(tabs: readonly TabDescriptor[], onScreen: readonly string[], previous: RefMarks | undefined): RefMarks {
  return {
    finished: sameList(
      previous?.finished,
      markedTabs(tabs, "finishedAt", onScreen).map((tab) => tab.tabId),
      NO_IDS,
    ),
    waiting: sameList(
      previous?.waiting,
      markedTabs(tabs, "waitingAt", onScreen).map((tab) => tab.tabId),
      NO_IDS,
    ),
    // The tabs the progress bar is about — runtime being prepared, CLI before its first frame.
    // Tabs on screen included: the bar is about the pane's own tabs.
    starting: sameList(
      previous?.starting,
      tabs.filter((tab) => tab.starting === true).map((tab) => tab.tabId),
      NO_IDS,
    ),
    working: tabs.some(isWorking),
  };
}

/**
 * The working session the project row's spinner shows next, one per press: the one after `shown`,
 * the first when `shown` stopped or is gone, and round again after the last. Viewing one does not
 * stop the spinner, so what was shown last is remembered by the caller.
 */
export function nextWorking(tabs: readonly TabDescriptor[], shown: string | undefined): TabDescriptor | undefined {
  const working = tabs.filter(isWorking);
  if (working.length === 0) {
    return undefined;
  }
  // -1 when the last shown tab stopped or is gone; the index wraps.
  const at = working.findIndex((tab) => tab.tabId === shown);
  return working[(at + 1) % working.length];
}

/**
 * Ctrl/Cmd+Shift+U, across all projects: the longest-waiting question, else the oldest finished
 * turn out of sight — so an unvisited project is not missed. `onScreenOf` names the tabs on screen
 * per repository or worktree.
 */
export function jumpTarget(
  tabs: Record<string, TabDescriptor[]>,
  onScreenOf: (refKey: string) => readonly string[],
): { refKey: string; tab: TabDescriptor } | undefined {
  // Through `markedTabs`, so the "not on screen" rule stays in one place.
  const collect = (field: MarkField): { refKey: string; tab: TabDescriptor }[] =>
    Object.keys(tabs)
      .flatMap((refKey) => markedTabs(tabs[refKey], field, onScreenOf(refKey)).map((tab) => ({ refKey, tab })))
      .sort((a, b) => (a.tab[field] ?? 0) - (b.tab[field] ?? 0));
  return collect("waitingAt")[0] ?? collect("finishedAt")[0];
}
