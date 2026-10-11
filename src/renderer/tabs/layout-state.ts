import {
  activateTab as activateTabLayout,
  collapseClosed,
  collapseEmpty,
  loadLayout,
  paneOf,
  PRESET_PANES,
  saveLayout,
  serializeLayout,
} from "./pane-layout";
import type { LayoutTab, PaneId, ProjectLayout } from "./pane-layout";
import type { PaneTab } from "./pane-tab";

/** Shared instance, so a pane's props stay identical for a repository or worktree that has none. */
export const NO_TABS: PaneTab[] = [];

/**
 * A repository's or worktree's layout (by its refKey): what is held, else what the last run saved.
 * Loaded at first sight, not up front: tabs can arrive before the open projects, and a layout
 * written then would overwrite the restore. `localStorage` is synchronous, so safe in an updater.
 */
export function layoutOf(layouts: Record<string, ProjectLayout>, refKey: string): ProjectLayout {
  return layouts[refKey] ?? loadLayout(refKey);
}

/**
 * Every layout reconciled with its tab list (`collapseClosed`), as a `setLayouts` updater; the same
 * object where none changed. `previousTabs` is the tab list each layout was last reconciled
 * against, per repository or worktree.
 *
 * `reconciled` holds the tab list each layout was reconciled against: reconciling it again against
 * the same list returns it unchanged, so a push for another repository or worktree skips it. Only a
 * cache, so safe to write in the updater.
 */
export function reconcileLayouts(
  current: Record<string, ProjectLayout>,
  tabs: Record<string, LayoutTab[]>,
  previousTabs: Record<string, LayoutTab[]>,
  reconciled: WeakMap<ProjectLayout, LayoutTab[]>,
): Record<string, ProjectLayout> {
  let next: Record<string, ProjectLayout> | undefined;
  for (const refKey of Object.keys(tabs)) {
    const list = tabs[refKey];
    const held = current[refKey];
    if (held && list === previousTabs[refKey] && reconciled.get(held) === list) {
      continue;
    }
    // The close trigger of the collapse; the move trigger is `activateIn`.
    const layout = collapseClosed(layoutOf(current, refKey), list, previousTabs[refKey] ?? NO_TABS);
    reconciled.set(layout, list);
    if (layout !== current[refKey]) {
      next ??= { ...current };
      next[refKey] = layout;
    }
  }
  return next ?? current;
}

/** A repository's or worktree's layout once its bootstrap has finished: every restored pane now has
 *  its sessions or never will, so the empty ones collapse. The same object where none does. */
export function settleLayout(
  current: Record<string, ProjectLayout>,
  refKey: string,
  tabs: LayoutTab[] | undefined,
): Record<string, ProjectLayout> {
  const layout = layoutOf(current, refKey);
  const collapsed = collapseEmpty(layout, tabs ?? NO_TABS);
  return collapsed === layout ? current : { ...current, [refKey]: collapsed };
}

/**
 * A tab made a pane's active one. Without `paneId` it resolves through `paneOf` (a project row's
 * mark, `placeTab`): where it lives, else the focused pane. Collapses on emptying a pane; the
 * other collapse trigger is a close (`reconcileLayouts`). A `paneId` the preset no longer has
 * (collapsed while a new tab was being created) resolves the same way, or the tab is drawn nowhere.
 */
export function activateIn(
  current: Record<string, ProjectLayout>,
  refKey: string,
  tabId: string,
  paneId: PaneId | undefined,
  tabs: LayoutTab[] | undefined,
): Record<string, ProjectLayout> {
  const layout = layoutOf(current, refKey);
  const target = paneId && PRESET_PANES[layout.preset].includes(paneId) ? paneId : paneOf(layout, tabId);
  return {
    ...current,
    [refKey]: activateTabLayout(layout, tabId, target, tabs ?? []),
  };
}

/** What was last written per repository or worktree, and whose bootstrap has finished. */
export interface LayoutPersistence {
  /**
   * The last written layout per repository or worktree. Saved on `tabs` too: output is keyed by
   * session id, so a push giving a tab one changes it. Compared as the string — spinner ticks
   * change `tabs` often.
   */
  saved: Record<string, string>;
  /** The layout and tab list last serialized per repository or worktree: the same pair serializes
   *  the same, so a push for another one skips it. */
  serialized: Record<string, { layout: ProjectLayout; tabs: LayoutTab[] }>;
  /**
   * Projects whose bootstrap has once finished. Before that, `serializeLayout` would drop every
   * pane whose sessions were not listed yet. From then on written regardless: a CLI booting is not
   * a listing in flight.
   */
  settled: Set<string>;
}

export function newLayoutPersistence(): LayoutPersistence {
  return { saved: {}, serialized: {}, settled: new Set() };
}

/** Writes every settled layout whose serialization changed since it was last written. */
export function persistLayouts(
  layouts: Record<string, ProjectLayout>,
  tabs: Record<string, LayoutTab[]>,
  persistence: LayoutPersistence,
): void {
  for (const [refKey, layout] of Object.entries(layouts)) {
    if (!persistence.settled.has(refKey)) {
      continue;
    }
    const list = tabs[refKey] ?? NO_TABS;
    const last = persistence.serialized[refKey];
    if (last?.layout === layout && last.tabs === list) {
      continue;
    }
    persistence.serialized[refKey] = { layout, tabs: list };
    const serialized = serializeLayout(layout, list);
    if (persistence.saved[refKey] !== serialized) {
      persistence.saved[refKey] = serialized;
      saveLayout(refKey, serialized);
    }
  }
}

/** Lets go of what is held of a removed repository's or worktree's persistence. */
export function forgetPersistence(persistence: LayoutPersistence, refKey: string): void {
  delete persistence.saved[refKey];
  delete persistence.serialized[refKey];
  persistence.settled.delete(refKey);
}
