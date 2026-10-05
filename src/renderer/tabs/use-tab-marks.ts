import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLatest } from "../ui/use-latest";
import { refKeyOf } from "../../shared/types/project";
import { isWorking } from "../../shared/types/terminals";
import type { ProjectRef } from "../../shared/types/project";
import type { TabDescriptor } from "../../shared/types/terminals";
import { forget, sameList, stableRecord } from "../identity";

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

/** Every repository's and worktree's tab marks, and the project row's ways to them. */
interface TabMarks {
  marks: Record<string, RefMarks>;
  showWorking: (refKey: string) => void;
  showFinished: (refKey: string) => void;
  showWaiting: (refKey: string) => void;
  jumpToWaiting: () => void;
  forgetProjectRef: (refKey: string) => void;
}

/**
 * The tab marks of every repository's and worktree's tabs, by `refKey`, decided against
 * `onScreenTabIds`, the active one's (`activeRefKey`, `activeRef`) tabs on screen; `showTab` is how
 * a mark's tab is brought there. `forgetProjectRef` drops a closed one's working cursor.
 */
export function useTabMarks(
  tabs: Record<string, TabDescriptor[]>,
  activeRefKey: string | null,
  activeRef: ProjectRef | null,
  onScreenTabIds: string[],
  showTab: (refKey: string, tabId: string) => void,
): TabMarks {
  const tabsRef = useLatest(tabs);

  /**
   * Finished or waiting sessions not on screen, oldest first — the tab strip's marks and
   * what the project row steps through. Tabs on screen are left out: nothing there was out of sight.
   * Decided here, once: main holds the mark but cannot see the screen, and two views must not each
   * decide.
   */
  const markedTabs = useCallback(
    (refKey: string, field: "finishedAt" | "waitingAt"): TabDescriptor[] => {
      const onScreen = refKey === activeRefKey ? onScreenTabIds : NO_IDS;
      return (tabs[refKey] ?? [])
        .filter((tab) => tab[field] !== undefined && !onScreen.includes(tab.tabId))
        .sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
    },
    [tabs, onScreenTabIds, activeRefKey],
  );

  /**
   * Tabs the progress bar is about — runtime being prepared, CLI before its first frame. Tabs on
   * screen included: the bar is about the pane's own tabs.
   */
  const startingTabs = useCallback(
    (refKey: string): TabDescriptor[] => (tabs[refKey] ?? []).filter((tab) => tab.starting === true),
    [tabs],
  );

  /**
   * The above as tab ids plus `working` (`RefMarks`), per repository or worktree, identity-stable
   * where unchanged: panes and the project list take them as props, and most pushes change nothing
   * here. `working` includes the tab on screen (a spinner is about now) but not one waiting on a
   * question: that session is not working, and both marks would stand side by side.
   */
  const marksRef = useRef<Record<string, RefMarks>>({});
  const marks = useMemo(() => {
    const next: Record<string, RefMarks> = {};
    for (const refKey of Object.keys(tabs)) {
      const previous = marksRef.current[refKey];
      next[refKey] = {
        finished: sameList(
          previous?.finished,
          markedTabs(refKey, "finishedAt").map((tab) => tab.tabId),
          NO_IDS,
        ),
        waiting: sameList(
          previous?.waiting,
          markedTabs(refKey, "waitingAt").map((tab) => tab.tabId),
          NO_IDS,
        ),
        starting: sameList(
          previous?.starting,
          startingTabs(refKey).map((tab) => tab.tabId),
          NO_IDS,
        ),
        working: (tabs[refKey] ?? []).some(isWorking),
      };
    }
    return stableRecord(marksRef, next);
  }, [tabs, markedTabs, startingTabs]);

  /**
   * The project row's spinner steps through working sessions, one per press. Viewing one does not
   * stop it, so the position is remembered — in a ref, since nothing on screen depends on it.
   *
   * These three read `tabsRef`/`marksRef`, not `tabs`: a dependency would remake them, and the
   * project list, on every push.
   */
  const workingCursor = useRef<Record<string, string>>({});
  const showWorking = useCallback(
    (refKey: string) => {
      const working = (tabsRef.current[refKey] ?? []).filter(isWorking);
      if (working.length === 0) {
        return;
      }
      // -1 when the last shown tab stopped or is gone; the index wraps.
      const at = working.findIndex((tab) => tab.tabId === workingCursor.current[refKey]);
      const next = working[(at + 1) % working.length];
      workingCursor.current[refKey] = next.tabId;
      showTab(refKey, next.tabId);
    },
    [showTab, tabsRef],
  );

  /** The project row's marks: the oldest finished session first, and the longest-waiting question. */
  const [showFinished, showWaiting] = useMemo(() => {
    const showFirst = (mark: "finished" | "waiting") => (refKey: string) => {
      const next = marksRef.current[refKey]?.[mark][0];
      if (next) {
        showTab(refKey, next);
      }
    };
    return [showFirst("finished"), showFirst("waiting")];
  }, [showTab]);

  /**
   * Tabs on screen (`onScreenTabIds`) count as seen, so their finished mark clears — behind a dialog or
   * another window it stays until the user is back. Main holds the mark but cannot see the screen.
   * Only the bubble: a question is hidden while on screen (`markedTabs`), not cleared, and reporting
   * it would cost an IPC per push.
   */
  useEffect(() => {
    if (!activeRef) {
      return;
    }
    for (const tab of tabs[refKeyOf(activeRef)] ?? []) {
      if (onScreenTabIds.includes(tab.tabId) && tab.finishedAt !== undefined) {
        window.tet.tabs.seen(activeRef, tab.tabId);
      }
    }
  }, [activeRef, onScreenTabIds, tabs]);

  /**
   * Ctrl/Cmd+Shift+U, across all projects: the longest-waiting question, else the oldest finished
   * turn out of sight — so an unvisited project is not missed.
   */
  const jumpToWaiting = useCallback(() => {
    // Through `markedTabs`, so the "not on screen" rule stays in one place.
    const collect = (field: "waitingAt" | "finishedAt"): { refKey: string; tab: TabDescriptor }[] =>
      Object.keys(tabs)
        .flatMap((refKey) => markedTabs(refKey, field).map((tab) => ({ refKey, tab })))
        .sort((a, b) => (a.tab[field] ?? 0) - (b.tab[field] ?? 0));
    const next = collect("waitingAt")[0] ?? collect("finishedAt")[0];
    if (next) {
      showTab(next.refKey, next.tab.tabId);
    }
  }, [tabs, markedTabs, showTab]);

  const forgetProjectRef = useCallback((refKey: string) => {
    workingCursor.current = forget(workingCursor.current, refKey);
  }, []);

  return { marks, showWorking, showFinished, showWaiting, jumpToWaiting, forgetProjectRef };
}
