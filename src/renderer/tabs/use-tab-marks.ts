import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLatest } from "../ui/use-latest";
import { refKeyOf } from "../../shared/types/project";
import type { ProjectRef } from "../../shared/types/project";
import type { TabDescriptor } from "../../shared/types/terminals";
import { forget, stableRecord } from "../identity";
import { jumpTarget, nextWorking, NO_IDS, refMarks, type RefMarks } from "./tab-marks";

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

  /** The tabs of a repository or worktree on screen: the active one's. */
  const onScreenOf = useCallback(
    (refKey: string): readonly string[] => (refKey === activeRefKey ? onScreenTabIds : NO_IDS),
    [activeRefKey, onScreenTabIds],
  );

  const marksRef = useRef<Record<string, RefMarks>>({});
  const marks = useMemo(() => {
    const next: Record<string, RefMarks> = {};
    for (const refKey of Object.keys(tabs)) {
      next[refKey] = refMarks(tabs[refKey], onScreenOf(refKey), marksRef.current[refKey]);
    }
    return stableRecord(marksRef, next);
  }, [tabs, onScreenOf]);

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
      const next = nextWorking(tabsRef.current[refKey] ?? [], workingCursor.current[refKey]);
      if (next) {
        workingCursor.current[refKey] = next.tabId;
        showTab(refKey, next.tabId);
      }
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

  /** Ctrl/Cmd+Shift+U (`jumpTarget`). */
  const jumpToWaiting = useCallback(() => {
    const next = jumpTarget(tabs, onScreenOf);
    if (next) {
      showTab(next.refKey, next.tab.tabId);
    }
  }, [tabs, onScreenOf, showTab]);

  const forgetProjectRef = useCallback((refKey: string) => {
    workingCursor.current = forget(workingCursor.current, refKey);
  }, []);

  return { marks, showWorking, showFinished, showWaiting, jumpToWaiting, forgetProjectRef };
}
