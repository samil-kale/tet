import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLatest } from "../ui/use-latest";
import { isWorking, projectRefKey } from "../../shared/types";
import type { ProjectRef, TerminalDescriptor } from "../../shared/types";
import { forget, sameList, stableRecord } from "../identity";

/** A repository's or worktree's marked sessions by tab id, oldest first: finished out of sight,
 *  waiting on an answer, and starting (so the pane a new agent opens in shows the bar,
 *  `TerminalsPane`'s `startingHere`). `busy` excludes a session stopped on a question. Decided in
 *  `useSessionMarks`, against what is on screen. */
export interface RefMarks {
  finished: string[];
  waiting: string[];
  starting: string[];
  busy: boolean;
}

/** Shared instance, so a pane's props stay identical for a project with none. */
export const NO_IDS: string[] = [];

/** Every repository's and worktree's session marks, and the project row's ways to them. */
interface SessionMarks {
  marks: Record<string, RefMarks>;
  showBusy: (key: string) => void;
  showFinished: (key: string) => void;
  showWaiting: (key: string) => void;
  showNeedsAttention: () => void;
  forgetProjectRef: (key: string) => void;
}

/**
 * The session marks of every repository's and worktree's tabs, by `projectRefKey`, decided against
 * `inFront`, the active one's (`activeKey`, `activeRef`) tabs in front of the user; `showTab` is how
 * a mark's tab is brought there. `forgetProjectRef` drops a closed one's busy cursor.
 */
export function useSessionMarks(
  tabs: Record<string, TerminalDescriptor[]>,
  activeKey: string | null,
  activeRef: ProjectRef | null,
  inFront: string[],
  showTab: (key: string, tabId: string) => void
): SessionMarks {
  const tabsRef = useLatest(tabs);

  /**
   * Finished or waiting sessions not in front of the user, oldest first — the tab strip's marks and
   * what the project row steps through. Tabs in front are left out: nothing there was out of sight.
   * Decided here, once: main holds the mark but cannot see the screen, and two views must not each
   * decide.
   */
  const markedTabs = useCallback(
    (key: string, field: "finishedAt" | "waitingAt"): TerminalDescriptor[] => {
      const onScreen = key === activeKey ? inFront : NO_IDS;
      return (tabs[key] ?? [])
        .filter((tab) => tab[field] !== undefined && !onScreen.includes(tab.tabId))
        .sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
    },
    [tabs, inFront, activeKey]
  );

  /**
   * Tabs the progress bar is about — runtime being prepared, CLI before its first frame. Tabs on
   * screen included: the bar is about the pane's own tabs.
   */
  const startingTabs = useCallback(
    (key: string): TerminalDescriptor[] => (tabs[key] ?? []).filter((tab) => tab.starting === true),
    [tabs]
  );

  /**
   * The above as tab ids plus `busy` (`RefMarks`), per repository or worktree, identity-stable
   * where unchanged: panes and the project list take them as props, and most pushes change nothing
   * here. `busy` includes the tab on screen (a spinner is about now) but not one waiting on a
   * question: that session is not working, and both marks would stand side by side.
   */
  const marksRef = useRef<Record<string, RefMarks>>({});
  const marks = useMemo(() => {
    const next: Record<string, RefMarks> = {};
    for (const key of Object.keys(tabs)) {
      const previous = marksRef.current[key];
      next[key] = {
        finished: sameList(previous?.finished, markedTabs(key, "finishedAt").map((tab) => tab.tabId), NO_IDS),
        waiting: sameList(previous?.waiting, markedTabs(key, "waitingAt").map((tab) => tab.tabId), NO_IDS),
        starting: sameList(previous?.starting, startingTabs(key).map((tab) => tab.tabId), NO_IDS),
        busy: (tabs[key] ?? []).some(isWorking)
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
  const busyCursor = useRef<Record<string, string>>({});
  const showBusy = useCallback(
    (key: string) => {
      const working = (tabsRef.current[key] ?? []).filter(isWorking);
      if (working.length === 0) {
        return;
      }
      // -1 when the last shown tab stopped or is gone; the index wraps.
      const at = working.findIndex((tab) => tab.tabId === busyCursor.current[key]);
      const next = working[(at + 1) % working.length];
      busyCursor.current[key] = next.tabId;
      showTab(key, next.tabId);
    },
    [showTab, tabsRef]
  );

  /** The project row's marks: the oldest finished session first, and the longest-waiting question. */
  const [showFinished, showWaiting] = useMemo(() => {
    const showFirst = (mark: "finished" | "waiting") => (key: string) => {
      const next = marksRef.current[key]?.[mark][0];
      if (next) {
        showTab(key, next);
      }
    };
    return [showFirst("finished"), showFirst("waiting")];
  }, [showTab]);

  /**
   * Tabs in front (`inFront`) count as seen, so their finished mark clears — behind a dialog or
   * another window it stays until the user is back. Main holds the mark but cannot see the screen.
   * Only the bubble: a question is hidden while in front (`markedTabs`), not cleared, and reporting
   * it would cost an IPC per push.
   */
  useEffect(() => {
    if (!activeRef) {
      return;
    }
    for (const tab of tabs[projectRefKey(activeRef)] ?? []) {
      if (inFront.includes(tab.tabId) && tab.finishedAt !== undefined) {
        window.tet.terminals.seen(activeRef, tab.tabId);
      }
    }
  }, [activeRef, inFront, tabs]);

  /**
   * Ctrl/Cmd+Shift+U, across all projects: the longest-waiting question, else the oldest finished
   * turn out of sight — so an unvisited project is not missed.
   */
  const showNeedsAttention = useCallback(() => {
    // Through `markedTabs`, so the "not on screen" rule stays in one place.
    const collect = (field: "waitingAt" | "finishedAt"): { key: string; tab: TerminalDescriptor }[] =>
      Object.keys(tabs)
        .flatMap((key) => markedTabs(key, field).map((tab) => ({ key, tab })))
        .sort((a, b) => (a.tab[field] ?? 0) - (b.tab[field] ?? 0));
    const next = collect("waitingAt")[0] ?? collect("finishedAt")[0];
    if (next) {
      showTab(next.key, next.tab.tabId);
    }
  }, [tabs, markedTabs, showTab]);

  const forgetProjectRef = useCallback((key: string) => {
    busyCursor.current = forget(busyCursor.current, key);
  }, []);

  return { marks, showBusy, showFinished, showWaiting, showNeedsAttention, forgetProjectRef };
}
