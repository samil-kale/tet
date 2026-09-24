import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  activateTab as activateTabLayout,
  collapseClosed,
  collapseEmpty,
  loadLayout,
  paneOf,
  placeCommandTab,
  saveLayout,
  serializeLayout,
  snapTab as snapTabLayout
} from "./pane-layout";
import type { LayoutTab, PaneId, ProjectLayout, SnapTransition } from "./pane-layout";
import type { PaneTab } from "./editor-tab";
import { forget } from "../identity";

/** Shared instance, so a pane's props stay identical for a project that has none. */
export const NO_TABS: PaneTab[] = [];

/**
 * A project's layout: what is held, else what the last run saved. Loaded at first sight, not up
 * front: tabs can arrive before the project list, and a layout written then would overwrite the
 * restore. `localStorage` is synchronous, so safe in an updater.
 */
function layoutOf(layouts: Record<string, ProjectLayout>, projectId: string): ProjectLayout {
  return layouts[projectId] ?? loadLayout(projectId);
}

/** Every project's split state, and the callbacks `App` hands the panes. */
interface ProjectLayouts {
  layouts: Record<string, ProjectLayout>;
  activateTab: (projectId: string, tabId: string, paneId?: PaneId) => void;
  snapTab: (projectId: string, tabId: string, transition: SnapTransition) => void;
  focusPane: (projectId: string, paneId: PaneId) => void;
  placeTab: (projectId: string, tabId: string, command?: string) => void;
  forgetLayout: (projectId: string) => void;
}

/**
 * Each project's split state. Held in `App`: the shortcuts and marks/seen need what is on screen
 * across panes (AGENTS.md, "Split view"). Reconciled against `tabs`, persisted once `starting`
 * first reports a project not starting.
 */
export function useProjectLayouts(
  tabs: Record<string, LayoutTab[]>,
  starting: Record<string, boolean>
): ProjectLayouts {
  const [layouts, setLayouts] = useState<Record<string, ProjectLayout>>({});
  /** The tab list `layouts` was last normalized against, per project — see `normalizeLayout`. */
  const previousTabsRef = useRef<Record<string, LayoutTab[]>>({});
  /** Read by the callbacks: depending on `tabs` would remake every pane's props on every push. */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /**
   * Reconciles every layout with its tab list (`collapseClosed`).
   *
   * A layout effect: a project's first tabs are its layout's first sight (`layoutOf`), and a
   * passive effect would paint one frame of the default layout. An unchanged layout is the same
   * object.
   */
  useLayoutEffect(() => {
    // Outside the updater, which may run late and must have no side effect.
    const previousTabs = previousTabsRef.current;
    previousTabsRef.current = tabs;
    setLayouts((current) => {
      let next: Record<string, ProjectLayout> | undefined;
      for (const projectId of Object.keys(tabs)) {
        // The close trigger of the collapse; the move trigger is `activateTab` below.
        const layout = collapseClosed(
          layoutOf(current, projectId),
          tabs[projectId] ?? NO_TABS,
          previousTabs[projectId] ?? NO_TABS
        );
        if (layout !== current[projectId]) {
          next ??= { ...current };
          next[projectId] = layout;
        }
      }
      return next ?? current;
    });
  }, [tabs]);

  /**
   * The last written layout per project. Saved on `tabs` too: output is keyed by session id, so a
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
    for (const [projectId, isStarting] of Object.entries(starting)) {
      if (isStarting || settledProjects.current.has(projectId)) {
        continue;
      }
      settledProjects.current.add(projectId);
      // Every restored pane now has its sessions or never will: collapse the empty ones first.
      setLayouts((current) => {
        const layout = layoutOf(current, projectId);
        const collapsed = collapseEmpty(layout, tabsRef.current[projectId] ?? NO_TABS);
        return collapsed === layout ? current : { ...current, [projectId]: collapsed };
      });
    }
  }, [starting]);
  useEffect(() => {
    for (const [projectId, layout] of Object.entries(layouts)) {
      if (!settledProjects.current.has(projectId)) {
        continue;
      }
      const serialized = serializeLayout(layout, tabs[projectId] ?? NO_TABS);
      if (savedLayoutsRef.current[projectId] !== serialized) {
        savedLayoutsRef.current[projectId] = serialized;
        saveLayout(projectId, serialized);
      }
    }
  }, [layouts, tabs, starting]);

  /**
   * Makes a tab a pane's active one. Without `paneId` it resolves through `paneOf` (a project row's
   * mark, `placeTab`): where it lives, else the focused pane. Collapses on emptying a pane; the
   * other collapse trigger is a close, in the reconcile effect.
   */
  const activateTab = useCallback((projectId: string, tabId: string, paneId?: PaneId) => {
    setLayouts((current) => {
      const layout = layoutOf(current, projectId);
      return {
        ...current,
        [projectId]: activateTabLayout(layout, tabId, paneId ?? paneOf(layout, tabId), tabsRef.current[projectId] ?? [])
      };
    });
  }, []);

  /** A tab dropped on a snap zone — see `snapTab`. */
  const snapTab = useCallback((projectId: string, tabId: string, transition: SnapTransition) => {
    setLayouts((current) => ({
      ...current,
      [projectId]: snapTabLayout(layoutOf(current, projectId), tabId, transition, tabsRef.current[projectId] ?? [])
    }));
  }, []);

  /** A pane taking focus without its active tab changing — a click on its terminal. */
  const focusPane = useCallback((projectId: string, paneId: PaneId) => {
    setLayouts((current) => {
      const layout = layoutOf(current, projectId);
      return layout.focusedPane === paneId ? current : { ...current, [projectId]: { ...layout, focusedPane: paneId } };
    });
  }, []);

  /**
   * Shows a tab opened from outside its pane. A saved command's tab goes where it last ran
   * (`placeCommandTab`); the line comes with the call, or off the tab list for one the control
   * channel opened (its push precedes the show).
   */
  const placeTab = useCallback(
    (projectId: string, tabId: string, command?: string) => {
      const line = command ?? tabsRef.current[projectId]?.find((tab) => tab.tabId === tabId)?.command;
      if (line === undefined) {
        activateTab(projectId, tabId);
        return;
      }
      setLayouts((current) => ({
        ...current,
        [projectId]: placeCommandTab(layoutOf(current, projectId), tabId, line, tabsRef.current[projectId] ?? [])
      }));
    },
    [activateTab]
  );

  /** Lets go of a closed project's state. */
  const forgetLayout = useCallback((projectId: string) => {
    setLayouts((current) => forget(current, projectId));
    delete previousTabsRef.current[projectId];
    delete savedLayoutsRef.current[projectId];
    settledProjects.current.delete(projectId);
  }, []);

  return { layouts, activateTab, snapTab, focusPane, placeTab, forgetLayout };
}
