import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  activateTab as activateTabLayout,
  collapseClosed,
  collapseEmpty,
  dropStoredLayout,
  loadLayout,
  paneOf,
  placeCommandTab,
  PRESET_PANES,
  saveLayout,
  serializeLayout,
  snapTab as snapTabLayout
} from "./pane-layout";
import type { LayoutTab, PaneId, ProjectLayout, SnapTransition } from "./pane-layout";
import type { PaneTab } from "./editor-tab";
import { forget } from "../identity";

/** Shared instance, so a pane's props stay identical for a checkout that has none. */
export const NO_TABS: PaneTab[] = [];

/**
 * A checkout's layout (by its key): what is held, else what the last run saved. Loaded at first sight, not up
 * front: tabs can arrive before the project list, and a layout written then would overwrite the
 * restore. `localStorage` is synchronous, so safe in an updater.
 */
function layoutOf(layouts: Record<string, ProjectLayout>, key: string): ProjectLayout {
  return layouts[key] ?? loadLayout(key);
}

/** Every checkout's split state, and the callbacks `App` hands the panes. */
interface ProjectLayouts {
  layouts: Record<string, ProjectLayout>;
  activateTab: (key: string, tabId: string, paneId?: PaneId) => void;
  snapTab: (key: string, tabId: string, transition: SnapTransition) => void;
  focusPane: (key: string, paneId: PaneId) => void;
  placeTab: (key: string, tabId: string, command?: string) => void;
  forgetLayout: (key: string) => void;
}

/**
 * Each checkout's split state, by checkout key. Held in `App`: the shortcuts and marks/seen need what is on screen
 * across panes (AGENTS.md, "Split view"). Reconciled against `tabs`, persisted once `starting`
 * first reports a checkout not starting.
 */
export function useProjectLayouts(
  tabs: Record<string, LayoutTab[]>,
  starting: Record<string, boolean>
): ProjectLayouts {
  const [layouts, setLayouts] = useState<Record<string, ProjectLayout>>({});
  /** The tab list `layouts` was last normalized against, per checkout — see `normalizeLayout`. */
  const previousTabsRef = useRef<Record<string, LayoutTab[]>>({});
  /** Read by the callbacks: depending on `tabs` would remake every pane's props on every push. */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /**
   * Reconciles every layout with its tab list (`collapseClosed`).
   *
   * A layout effect: a checkout's first tabs are its layout's first sight (`layoutOf`), and a
   * passive effect would paint one frame of the default layout. An unchanged layout is the same
   * object.
   */
  useLayoutEffect(() => {
    // Outside the updater, which may run late and must have no side effect.
    const previousTabs = previousTabsRef.current;
    previousTabsRef.current = tabs;
    setLayouts((current) => {
      let next: Record<string, ProjectLayout> | undefined;
      for (const key of Object.keys(tabs)) {
        // The close trigger of the collapse; the move trigger is `activateTab` below.
        const layout = collapseClosed(
          layoutOf(current, key),
          tabs[key] ?? NO_TABS,
          previousTabs[key] ?? NO_TABS
        );
        if (layout !== current[key]) {
          next ??= { ...current };
          next[key] = layout;
        }
      }
      return next ?? current;
    });
  }, [tabs]);

  /**
   * The last written layout per checkout. Saved on `tabs` too: output is keyed by session id, so a
   * push giving a tab one changes it. Compared as the string — spinner ticks change `tabs` often.
   */
  const savedLayoutsRef = useRef<Record<string, string>>({});
  /**
   * Projects whose bootstrap has once finished. Before that, `serializeLayout` would drop every
   * pane whose sessions were not listed yet. From then on written regardless: a CLI booting is not
   * a listing in flight.
   */
  const settledProjects = useRef(new Set<string>());
  useEffect(() => {
    for (const [key, isStarting] of Object.entries(starting)) {
      if (isStarting || settledProjects.current.has(key)) {
        continue;
      }
      settledProjects.current.add(key);
      // Every restored pane now has its sessions or never will: collapse the empty ones first.
      setLayouts((current) => {
        const layout = layoutOf(current, key);
        const collapsed = collapseEmpty(layout, tabsRef.current[key] ?? NO_TABS);
        return collapsed === layout ? current : { ...current, [key]: collapsed };
      });
    }
  }, [starting]);
  useEffect(() => {
    for (const [key, layout] of Object.entries(layouts)) {
      if (!settledProjects.current.has(key)) {
        continue;
      }
      const serialized = serializeLayout(layout, tabs[key] ?? NO_TABS);
      if (savedLayoutsRef.current[key] !== serialized) {
        savedLayoutsRef.current[key] = serialized;
        saveLayout(key, serialized);
      }
    }
  }, [layouts, tabs, starting]);

  /**
   * Makes a tab a pane's active one. Without `paneId` it resolves through `paneOf` (a project row's
   * mark, `placeTab`): where it lives, else the focused pane. Collapses on emptying a pane; the
   * other collapse trigger is a close, in the reconcile effect. A `paneId` the preset no longer has
   * (collapsed while a new tab was being created) resolves the same way, or the tab is drawn nowhere.
   */
  const activateTab = useCallback((key: string, tabId: string, paneId?: PaneId) => {
    setLayouts((current) => {
      const layout = layoutOf(current, key);
      const target = paneId && PRESET_PANES[layout.preset].includes(paneId) ? paneId : paneOf(layout, tabId);
      return {
        ...current,
        [key]: activateTabLayout(layout, tabId, target, tabsRef.current[key] ?? [])
      };
    });
  }, []);

  /** A tab dropped on a snap zone — see `snapTab`. */
  const snapTab = useCallback((key: string, tabId: string, transition: SnapTransition) => {
    setLayouts((current) => ({
      ...current,
      [key]: snapTabLayout(layoutOf(current, key), tabId, transition, tabsRef.current[key] ?? [])
    }));
  }, []);

  /** A pane taking focus without its active tab changing — a click on its terminal. */
  const focusPane = useCallback((key: string, paneId: PaneId) => {
    setLayouts((current) => {
      const layout = layoutOf(current, key);
      return layout.focusedPane === paneId ? current : { ...current, [key]: { ...layout, focusedPane: paneId } };
    });
  }, []);

  /**
   * Shows a tab opened from outside its pane. A saved command's tab goes where it last ran
   * (`placeCommandTab`); the line comes with the call, or off the tab list for one the control
   * channel opened (its push precedes the show).
   */
  const placeTab = useCallback(
    (key: string, tabId: string, command?: string) => {
      const line = command ?? tabsRef.current[key]?.find((tab) => tab.tabId === tabId)?.command;
      if (line === undefined) {
        activateTab(key, tabId);
        return;
      }
      setLayouts((current) => ({
        ...current,
        [key]: placeCommandTab(layoutOf(current, key), tabId, line, tabsRef.current[key] ?? [])
      }));
    },
    [activateTab]
  );

  /** Lets go of a removed checkout's state, what is stored of it too. */
  const forgetLayout = useCallback((key: string) => {
    setLayouts((current) => forget(current, key));
    dropStoredLayout(key);
    delete previousTabsRef.current[key];
    delete savedLayoutsRef.current[key];
    settledProjects.current.delete(key);
  }, []);

  return { layouts, activateTab, snapTab, focusPane, placeTab, forgetLayout };
}
