import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLatest } from "../ui/use-latest";
import { dropOnStrip as dropOnStripLayout, dropStoredLayout, placeCommandTab, snapTab as snapTabLayout } from "./pane-layout";
import type { LayoutTab, PaneId, ProjectLayout, SnapTransition } from "./pane-layout";
import {
  activateIn,
  forgetPersistence,
  layoutOf,
  newLayoutPersistence,
  persistLayouts,
  reconcileLayouts,
  settleLayout,
} from "./layout-state";
import { forget } from "../identity";
import { editorEntry } from "../editor/editor-views";

/** Every repository's and worktree's split state, and the callbacks `App` hands the panes. */
interface ProjectLayouts {
  layouts: Record<string, ProjectLayout>;
  activateTab: (refKey: string, tabId: string, paneId?: PaneId) => void;
  snapTab: (refKey: string, tabId: string, transition: SnapTransition) => void;
  dropOnStrip: (refKey: string, tabId: string, paneId: PaneId, before: string | undefined) => void;
  focusPane: (refKey: string, paneId: PaneId) => void;
  placeTab: (refKey: string, tabId: string, command?: string) => void;
  forgetLayout: (refKey: string) => void;
}

/**
 * Each repository's or worktree's split state, by `refKey`. Held in `App`: the shortcuts and
 * marks/seen need what is on screen across panes (AGENTS.md, "Split view"). Reconciled against
 * `tabs`, persisted once `starting` first reports a repository or worktree not starting — which
 * main holds until the window has brought back its tabs too (`TabSessionManager.restore`).
 */
export function useProjectLayouts(tabs: Record<string, LayoutTab[]>, starting: Record<string, boolean>): ProjectLayouts {
  const [layouts, setLayouts] = useState<Record<string, ProjectLayout>>({});
  /** The tab list `layouts` was last normalized against, per repository or worktree — see
   *  `normalizeLayout`. */
  const previousTabsRef = useRef<Record<string, LayoutTab[]>>({});
  /**
   * The tab list each layout was reconciled against: reconciling it again against the same list
   * returns it unchanged, so a push for another repository or worktree skips it. Only a cache, so
   * safe to write in the updater.
   */
  const reconciledRef = useRef(new WeakMap<ProjectLayout, LayoutTab[]>());
  /** Read by the callbacks: depending on `tabs` would remake every pane's props on every push. */
  const tabsRef = useLatest(tabs);
  /** What was last written, and whose bootstrap has finished (`LayoutPersistence`). */
  const persistence = useRef(newLayoutPersistence());

  /**
   * Reconciles every layout with its tab list (`collapseClosed`).
   *
   * A layout effect: a repository's or worktree's first tabs are its layout's first sight
   * (`layoutOf`), and a passive effect would paint one frame of the default layout. An unchanged
   * layout is the same object.
   */
  useLayoutEffect(() => {
    // Outside the updater, which may run late and must have no side effect.
    const previousTabs = previousTabsRef.current;
    previousTabsRef.current = tabs;
    const reconciled = reconciledRef.current;
    // As settled at this push: the updater may run once a project has settled since.
    const settled = new Set(persistence.current.settled);
    setLayouts((current) => reconcileLayouts(current, tabs, previousTabs, reconciled, settled));
  }, [tabs]);

  useEffect(() => {
    for (const [refKey, isStarting] of Object.entries(starting)) {
      if (isStarting || persistence.current.settled.has(refKey)) {
        continue;
      }
      persistence.current.settled.add(refKey);
      setLayouts((current) => settleLayout(current, refKey, tabsRef.current[refKey]));
    }
  }, [starting, tabsRef]);
  useEffect(() => {
    persistLayouts(layouts, tabs, persistence.current, editorEntry);
  }, [layouts, tabs, starting]);
  // As the window goes, everything once more: the editors' state changes beside the layout, and
  // their cursor and scroll are read only then.
  const layoutsRef = useLatest(layouts);
  useEffect(() => {
    const onUnload = (): void => persistLayouts(layoutsRef.current, tabsRef.current, persistence.current, editorEntry, true);
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [layoutsRef, tabsRef]);

  /** Makes a tab a pane's active one (`activateIn`). */
  const activateTab = useCallback(
    (refKey: string, tabId: string, paneId?: PaneId) => {
      setLayouts((current) => activateIn(current, refKey, tabId, paneId, tabsRef.current[refKey]));
    },
    [tabsRef],
  );

  /** A tab dropped on a snap zone — see `snapTab`. */
  const snapTab = useCallback(
    (refKey: string, tabId: string, transition: SnapTransition) => {
      setLayouts((current) => ({
        ...current,
        [refKey]: snapTabLayout(layoutOf(current, refKey), tabId, transition, tabsRef.current[refKey] ?? []),
      }));
    },
    [tabsRef],
  );

  /** A tab dropped on a pane's strip — see `dropOnStrip`. */
  const dropOnStrip = useCallback(
    (refKey: string, tabId: string, paneId: PaneId, before: string | undefined) => {
      setLayouts((current) => ({
        ...current,
        [refKey]: dropOnStripLayout(layoutOf(current, refKey), tabId, paneId, before, tabsRef.current[refKey] ?? []),
      }));
    },
    [tabsRef],
  );

  /** A pane taking focus without its active tab changing — a click on its terminal. */
  const focusPane = useCallback((refKey: string, paneId: PaneId) => {
    setLayouts((current) => {
      const layout = layoutOf(current, refKey);
      return layout.focusedPane === paneId ? current : { ...current, [refKey]: { ...layout, focusedPane: paneId } };
    });
  }, []);

  /**
   * Shows a tab opened from outside its pane. A saved command's tab goes where it last ran
   * (`placeCommandTab`); the line comes with the call, or off the tab list for one the control
   * channel opened (its push precedes the show).
   */
  const placeTab = useCallback(
    (refKey: string, tabId: string, command?: string) => {
      const line = command ?? tabsRef.current[refKey]?.find((tab) => tab.tabId === tabId)?.command;
      if (line === undefined) {
        activateTab(refKey, tabId);
        return;
      }
      setLayouts((current) => ({
        ...current,
        [refKey]: placeCommandTab(layoutOf(current, refKey), tabId, line, tabsRef.current[refKey] ?? []),
      }));
    },
    [activateTab, tabsRef],
  );

  /** Lets go of a removed repository's or worktree's state, what is stored of it too. */
  const forgetLayout = useCallback((refKey: string) => {
    setLayouts((current) => forget(current, refKey));
    dropStoredLayout(refKey);
    delete previousTabsRef.current[refKey];
    forgetPersistence(persistence.current, refKey);
  }, []);

  return { layouts, activateTab, snapTab, dropOnStrip, focusPane, placeTab, forgetLayout };
}
