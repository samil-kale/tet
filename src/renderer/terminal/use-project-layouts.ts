import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalDescriptor } from "../../shared/types";
import {
  activateTab as activateTabLayout,
  applyPreset,
  collapseClosed,
  collapseEmpty,
  loadLayout,
  paneOf,
  placeCommandTab,
  saveLayout,
  serializeLayout,
  snapTab as snapTabLayout
} from "./pane-layout";
import type { PaneId, ProjectLayout, SnapTransition, SplitPreset } from "./pane-layout";

/** Shared instance, so a pane's props stay identical for a project that has none. */
export const NO_TABS: TerminalDescriptor[] = [];

/**
 * A project's layout: what is held, else what the last run left on disk. Loaded at first sight,
 * not up front: a project's tabs can arrive before the project list, and a layout written for them
 * then would overwrite a later restore. `localStorage` is synchronous, so reading it in an updater
 * is safe.
 */
function layoutOf(layouts: Record<string, ProjectLayout>, projectId: string): ProjectLayout {
  return layouts[projectId] ?? loadLayout(projectId);
}

/** Every project's split state, and the callbacks `App` hands the panes. */
export interface ProjectLayouts {
  layouts: Record<string, ProjectLayout>;
  activateTab: (projectId: string, tabId: string, paneId?: PaneId) => void;
  snapTab: (projectId: string, tabId: string, transition: SnapTransition) => void;
  focusPane: (projectId: string, paneId: PaneId) => void;
  setPreset: (projectId: string, preset: SplitPreset) => void;
  placeTab: (projectId: string, tabId: string, command?: string) => void;
  forgetLayout: (projectId: string) => void;
}

/**
 * Each project's split state: preset, focused pane, tab→pane, and each pane's active tab. Called
 * from `App`, which holds it, because the shortcuts and the marks/seen logic need what is on
 * screen across every pane — see "Split view" in CLAUDE.md. Reconciled against `tabs`, and
 * persisted from the first time `starting` reports a project not starting.
 */
export function useProjectLayouts(
  tabs: Record<string, TerminalDescriptor[]>,
  starting: Record<string, boolean>
): ProjectLayouts {
  const [layouts, setLayouts] = useState<Record<string, ProjectLayout>>({});
  /** The tab list `layouts` was last normalized against, per project — see `normalizeLayout`. */
  const previousTabsRef = useRef<Record<string, TerminalDescriptor[]>>({});
  /**
   * For the callbacks that only read it on a click: depending on `tabs` would remake them, and
   * every pane's props, on every push from any project.
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /**
   * Reconciles every project's layout with its tab list: a closed tab drops out of its pane, a pane
   * left empty goes to null, an unassigned tab settles into the focused pane (`normalizeLayout`;
   * `previousTabsRef` tells "closed" from "not created yet").
   *
   * A layout effect: a project's first tabs are its layout's first sight (`layoutOf`), and a
   * passive effect would paint one frame with the default layout. Cheap: an unchanged layout is
   * the same object.
   */
  useLayoutEffect(() => {
    // Advanced outside the updater, which may run later than queued and must carry no side effect.
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
   * Persists every project's layout when what would be written changes. On `tabs` too: the output
   * is keyed by session id (`serializeLayout`), so a push adding one to a tab changes it without
   * touching the layout. Compared as the written string — a spinner tick changes `tabs` many
   * times a minute.
   */
  const savedLayoutsRef = useRef<Record<string, string>>({});
  /**
   * Projects whose bootstrap has once finished. Tabs arrive agent by agent while it runs, and
   * `serializeLayout` trims to the tabs that exist — written during that window, the layout would
   * drop every pane whose sessions had not been listed yet, permanently on quit. From the first
   * settle on it is written regardless: a CLI booting is not a listing in flight.
   */
  const settledProjects = useRef(new Set<string>());
  useEffect(() => {
    for (const [projectId, isStarting] of Object.entries(starting)) {
      if (isStarting || settledProjects.current.has(projectId)) {
        continue;
      }
      settledProjects.current.add(projectId);
      // Every pane of a restored layout now either has its sessions or never will: collapse what is
      // empty before the layout is first written.
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
   * Makes a tab the active one of a pane — a click, a move, a new tab. `paneId` pins the pane;
   * left out, it resolves through `paneOf` (a tab shown from a project row's mark, a saved
   * command, `placeTab`): where it already lives, else the focused pane. The move and the collapse
   * when it empties a pane are the model's `activateTab`; the other collapse trigger is a close, in
   * the reconcile effect. A snap (`snapTab`) is neither.
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

  /** A tab dropped on a snap zone: preset switch and move in one write — see `snapTab`. */
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

  /** The layout dropdown: switches a project's preset, redistributing panes that no longer exist. */
  const setPreset = useCallback((projectId: string, preset: SplitPreset) => {
    setLayouts((current) => ({
      ...current,
      [projectId]: applyPreset(layoutOf(current, projectId), preset, tabsRef.current[projectId] ?? [])
    }));
  }, []);

  /**
   * Puts a tab opened from outside its own pane in front of the user. A saved command's tab goes to
   * the pane that command last ran in (`placeCommandTab`); the command line comes with the call, or
   * off the tab list for one the control channel opened (its push precedes the show).
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

  /** Everything held for a closed project, let go of; the project list itself is `App`'s. */
  const forgetLayout = useCallback((projectId: string) => {
    setLayouts((current) => {
      const rest = { ...current };
      delete rest[projectId];
      return rest;
    });
    delete previousTabsRef.current[projectId];
    delete savedLayoutsRef.current[projectId];
    settledProjects.current.delete(projectId);
  }, []);

  return { layouts, activateTab, snapTab, focusPane, setPreset, placeTab, forgetLayout };
}
