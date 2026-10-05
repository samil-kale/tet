import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLatest } from "../ui/use-latest";
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
  snapTab as snapTabLayout,
} from "./pane-layout";
import type { LayoutTab, PaneId, ProjectLayout, SnapTransition } from "./pane-layout";
import type { PaneTab } from "../editor/editor-tab";
import { forget } from "../identity";

/** Shared instance, so a pane's props stay identical for a repository or worktree that has none. */
export const NO_TABS: PaneTab[] = [];

/**
 * A repository's or worktree's layout (by its refKey): what is held, else what the last run saved.
 * Loaded at first sight, not up front: tabs can arrive before the open projects, and a layout
 * written then would overwrite the restore. `localStorage` is synchronous, so safe in an updater.
 */
function layoutOf(layouts: Record<string, ProjectLayout>, refKey: string): ProjectLayout {
  return layouts[refKey] ?? loadLayout(refKey);
}

/** Every repository's and worktree's split state, and the callbacks `App` hands the panes. */
interface ProjectLayouts {
  layouts: Record<string, ProjectLayout>;
  activateTab: (refKey: string, tabId: string, paneId?: PaneId) => void;
  snapTab: (refKey: string, tabId: string, transition: SnapTransition) => void;
  focusPane: (refKey: string, paneId: PaneId) => void;
  placeTab: (refKey: string, tabId: string, command?: string) => void;
  forgetLayout: (refKey: string) => void;
}

/**
 * Each repository's or worktree's split state, by `refKey`. Held in `App`: the shortcuts and
 * marks/seen need what is on screen across panes (AGENTS.md, "Split view"). Reconciled against
 * `tabs`, persisted once `starting` first reports a repository or worktree not starting.
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
    setLayouts((current) => {
      let next: Record<string, ProjectLayout> | undefined;
      for (const refKey of Object.keys(tabs)) {
        const list = tabs[refKey] ?? NO_TABS;
        const held = current[refKey];
        if (held && list === previousTabs[refKey] && reconciled.get(held) === list) {
          continue;
        }
        // The close trigger of the collapse; the move trigger is `activateTab` below.
        const layout = collapseClosed(layoutOf(current, refKey), list, previousTabs[refKey] ?? NO_TABS);
        reconciled.set(layout, list);
        if (layout !== current[refKey]) {
          next ??= { ...current };
          next[refKey] = layout;
        }
      }
      return next ?? current;
    });
  }, [tabs]);

  /**
   * The last written layout per repository or worktree. Saved on `tabs` too: output is keyed by
   * session id, so a push giving a tab one changes it. Compared as the string — spinner ticks
   * change `tabs` often.
   */
  const savedLayoutsRef = useRef<Record<string, string>>({});
  /** The layout and tab list last serialized per repository or worktree: the same pair serializes
   *  the same, so a push for another one skips it. */
  const serializedRef = useRef<Record<string, { layout: ProjectLayout; tabs: LayoutTab[] }>>({});
  /**
   * Projects whose bootstrap has once finished. Before that, `serializeLayout` would drop every
   * pane whose sessions were not listed yet. From then on written regardless: a CLI booting is not
   * a listing in flight.
   */
  const settledProjects = useRef(new Set<string>());
  useEffect(() => {
    for (const [refKey, isStarting] of Object.entries(starting)) {
      if (isStarting || settledProjects.current.has(refKey)) {
        continue;
      }
      settledProjects.current.add(refKey);
      // Every restored pane now has its sessions or never will: collapse the empty ones first.
      setLayouts((current) => {
        const layout = layoutOf(current, refKey);
        const collapsed = collapseEmpty(layout, tabsRef.current[refKey] ?? NO_TABS);
        return collapsed === layout ? current : { ...current, [refKey]: collapsed };
      });
    }
  }, [starting, tabsRef]);
  useEffect(() => {
    for (const [refKey, layout] of Object.entries(layouts)) {
      if (!settledProjects.current.has(refKey)) {
        continue;
      }
      const list = tabs[refKey] ?? NO_TABS;
      const last = serializedRef.current[refKey];
      if (last?.layout === layout && last.tabs === list) {
        continue;
      }
      serializedRef.current[refKey] = { layout, tabs: list };
      const serialized = serializeLayout(layout, list);
      if (savedLayoutsRef.current[refKey] !== serialized) {
        savedLayoutsRef.current[refKey] = serialized;
        saveLayout(refKey, serialized);
      }
    }
  }, [layouts, tabs, starting]);

  /**
   * Makes a tab a pane's active one. Without `paneId` it resolves through `paneOf` (a project row's
   * mark, `placeTab`): where it lives, else the focused pane. Collapses on emptying a pane; the
   * other collapse trigger is a close, in the reconcile effect. A `paneId` the preset no longer has
   * (collapsed while a new tab was being created) resolves the same way, or the tab is drawn nowhere.
   */
  const activateTab = useCallback(
    (refKey: string, tabId: string, paneId?: PaneId) => {
      setLayouts((current) => {
        const layout = layoutOf(current, refKey);
        const target = paneId && PRESET_PANES[layout.preset].includes(paneId) ? paneId : paneOf(layout, tabId);
        return {
          ...current,
          [refKey]: activateTabLayout(layout, tabId, target, tabsRef.current[refKey] ?? []),
        };
      });
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
    delete savedLayoutsRef.current[refKey];
    delete serializedRef.current[refKey];
    settledProjects.current.delete(refKey);
  }, []);

  return { layouts, activateTab, snapTab, focusPane, placeTab, forgetLayout };
}
