import type { TerminalDescriptor } from "../shared/types";
import { sameRecord } from "./identity";

/**
 * A terminal split view, VS Code's editor groups reduced to a fixed set of presets rather than a
 * freely nestable tree — see CLAUDE.md's "Split view" section for why. At most four panes, so
 * four letters are all the identity a pane ever needs.
 */
export type PaneId = "a" | "b" | "c" | "d";
export const PANE_IDS: readonly PaneId[] = ["a", "b", "c", "d"];

export type SplitPreset = "single" | "cols2" | "cols3" | "split-right" | "grid2x2";
/** Every preset, in the order the layout menu lists them. */
export const PRESETS: readonly SplitPreset[] = ["single", "cols2", "cols3", "split-right", "grid2x2"];

export function isPaneId(value: unknown): value is PaneId {
  return PANE_IDS.includes(value as PaneId);
}

export function isSplitPreset(value: unknown): value is SplitPreset {
  return PRESETS.includes(value as SplitPreset);
}

/** A tab dragged onto another pane — its own MIME, so a dropped file is never mistaken for one. */
export const TAB_DRAG_TYPE = "application/x-tet-terminal-tab";

/** Which panes exist for a preset, in reading order — also the "move to" menu's own order. */
export const PRESET_PANES: Record<SplitPreset, PaneId[]> = {
  single: ["a"],
  cols2: ["a", "b"],
  cols3: ["a", "b", "c"],
  "split-right": ["a", "b", "c"],
  grid2x2: ["a", "b", "c", "d"]
};

export const PRESET_LABELS: Record<SplitPreset, string> = {
  single: "Single",
  cols2: "Two Columns",
  cols3: "Three Columns",
  "split-right": "Two Columns, Right Split",
  grid2x2: "Grid (2x2)"
};

/** A short, position-based name for a pane — what "move to" menu entries and tooltips show. */
export const PANE_LABELS: Record<SplitPreset, Partial<Record<PaneId, string>>> = {
  single: {},
  cols2: { a: "Left", b: "Right" },
  cols3: { a: "Left", b: "Middle", c: "Right" },
  "split-right": { a: "Left", b: "Top Right", c: "Bottom Right" },
  grid2x2: { a: "Top Left", b: "Top Right", c: "Bottom Left", d: "Bottom Right" }
};

/** A project's split state — held in `App`, not in `TerminalsPane`, see CLAUDE.md for why. */
export interface ProjectLayout {
  preset: SplitPreset;
  /** Where a new tab lands and what the tab shortcuts act on; keyboard focus follows it. */
  focusedPane: PaneId;
  /** Which pane an open tab belongs to, by tab id. Assigned lazily — see `normalizeLayout`. */
  tabPane: Record<string, PaneId>;
  /** Each pane's own active tab. */
  activeTab: Partial<Record<PaneId, string | null>>;
}

export function defaultLayout(): ProjectLayout {
  return { preset: "single", focusedPane: "a", tabPane: {}, activeTab: {} };
}

/** Which pane a tab lives in, falling back to the focused pane for one never assigned yet. */
export function paneOf(layout: ProjectLayout, tabId: string): PaneId {
  return layout.tabPane[tabId] ?? layout.focusedPane;
}

/** Every tab currently shown, one per pane — what "on screen" means once there is more than one. */
export function visibleTabIds(layout: ProjectLayout): string[] {
  return Object.values(layout.activeTab).filter((id): id is string => id != null);
}

/** The tab a pane keeps active once `wanted` (its previous active tab) is gone from `list`. */
function pickActive(
  list: TerminalDescriptor[],
  previousList: TerminalDescriptor[],
  wanted: string | null | undefined
): string | null {
  if (wanted && list.some((tab) => tab.tabId === wanted)) {
    return wanted;
  }
  // Not in the list, but never was — a tab just activated whose own push has not arrived yet.
  // Left alone rather than reassigned, or the neighbour rule below would immediately steal the
  // selection back from a tab that is about to exist. Only ever an id set during this run:
  // `activeTab` is deliberately not persisted (see `saveLayout`), so nothing stale from a
  // previous one can sit here waiting for a tab that never comes.
  if (wanted && !previousList.some((tab) => tab.tabId === wanted)) {
    return wanted;
  }
  if (list.length === 0) {
    return null;
  }
  if (!wanted) {
    // First tab this pane has ever shown: the session the user last worked in.
    return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0].tabId;
  }
  // Closed for good: VS Code's own rule, the nearest neighbour on the right, or on the left if
  // the closed tab was the rightmost one.
  const index = previousList.findIndex((tab) => tab.tabId === wanted);
  return list[Math.min(Math.max(index, 0), list.length - 1)].tabId;
}

/**
 * Keeps a layout honest against the current tab list, called whenever it changes: every pane's
 * active tab either still exists, is reassigned to a neighbour within its own pane, or goes to
 * null once that pane has nothing left of its own. `tabPane` entries for tabs that are gone for
 * good are dropped the same way. `previousTabs` is what makes "gone for good" possible to tell
 * apart from "not created yet" — see `pickActive`.
 *
 * A `tabPane` entry for a tab in neither list is kept: the session listing behind a project's
 * tabs arrives agent by agent at startup, so an entry restored from disk may name a tab whose
 * push simply hasn't come yet. One that never comes (a session deleted between runs) costs a
 * dictionary entry until the next `saveLayout`, which only writes what exists — never a wrong
 * pane, since `paneOf` is only ever asked about tabs that do.
 *
 * Returns `layout` itself, identity and all, when nothing changed — most calls, since most tab
 * list pushes touch no pane's own assignment. `App` re-renders every memoized view a project's
 * layout reaches on every new object here, whether or not anything about it actually changed.
 */
export function normalizeLayout(
  layout: ProjectLayout,
  tabs: TerminalDescriptor[],
  previousTabs: TerminalDescriptor[]
): ProjectLayout {
  const panes = PRESET_PANES[layout.preset];
  const previousIds = new Set(previousTabs.map((tab) => tab.tabId));
  const currentIds = new Set(tabs.map((tab) => tab.tabId));
  const tabPane: Record<string, PaneId> = {};
  for (const [tabId, paneId] of Object.entries(layout.tabPane)) {
    // Still open, or not confirmed closed — see above.
    if (panes.includes(paneId) && (currentIds.has(tabId) || !previousIds.has(tabId))) {
      tabPane[tabId] = paneId;
    }
  }
  // A tab with no pane of its own yet settles in the pane that is focused when it is first
  // seen — written now so it does not keep following the focus around afterwards.
  for (const tab of tabs) {
    tabPane[tab.tabId] ??= layout.focusedPane;
  }
  const listOf = (source: TerminalDescriptor[], paneId: PaneId): TerminalDescriptor[] =>
    source.filter((tab) => (tabPane[tab.tabId] ?? layout.focusedPane) === paneId);
  const activeTab: Partial<Record<PaneId, string | null>> = {};
  for (const paneId of panes) {
    activeTab[paneId] = pickActive(listOf(tabs, paneId), listOf(previousTabs, paneId), layout.activeTab[paneId]);
  }
  const focusedPane = panes.includes(layout.focusedPane) ? layout.focusedPane : panes[0];
  const nextTabPane = sameRecord(layout.tabPane, tabPane);
  const nextActiveTab = sameRecord(layout.activeTab, activeTab);
  if (focusedPane === layout.focusedPane && nextTabPane === layout.tabPane && nextActiveTab === layout.activeTab) {
    return layout;
  }
  return { preset: layout.preset, focusedPane, tabPane: nextTabPane, activeTab: nextActiveTab };
}

/**
 * A preset switch: panes that no longer exist hand their tabs to pane "a" — always present in
 * every preset, and simplest, since a switch this rare does not deserve a "closest" mapping to
 * get right. Re-normalized at once so the new preset's panes have a valid active tab immediately
 * rather than waiting for the next tab list push.
 */
export function applyPreset(layout: ProjectLayout, preset: SplitPreset, tabs: TerminalDescriptor[]): ProjectLayout {
  if (preset === layout.preset) {
    return layout;
  }
  const panes = PRESET_PANES[preset];
  const tabPane = Object.fromEntries(
    Object.entries(layout.tabPane).map(([tabId, paneId]) => [tabId, panes.includes(paneId) ? paneId : "a"])
  );
  const focusedPane = panes.includes(layout.focusedPane) ? layout.focusedPane : "a";
  return normalizeLayout({ preset, focusedPane, tabPane, activeTab: layout.activeTab }, tabs, tabs);
}

/**
 * Where a project's split state lives between runs: `localStorage`, under the same
 * `tet.layout.` namespace `Sash.tsx` keeps every other pane size in — layout describes the
 * window, not the repository. Per project, so the key needs the project id, which is why this
 * cannot go through `usePaneSize`/`usePaneToggle` (their key is fixed at the call site) and why
 * `App` reads and writes it by hand instead. `suffix` tells the layout itself apart from the
 * divider positions `TerminalsPane` keeps under the same project.
 */
export function layoutStorageKey(projectId: string, suffix: string): string {
  return `tet.layout.terminals.${projectId}.${suffix}`;
}

/**
 * What survives a restart: the preset, the focused pane, and which pane each tab lives in —
 * keyed by *session id*, not tab id. A tab created during a run has an id of its own that means
 * nothing to the next run (`new-N`, handed out from zero again at every start), and comes back —
 * if it comes back at all — under its agent's session id, which a restored tab uses as its tab
 * id from the outset. Keying by session id makes both the same entry, and drops on its own what
 * cannot return: a shell tab, or an agent tab whose CLI never persisted a session.
 *
 * Deliberately not here: each pane's active tab. A stale one — a session deleted between runs —
 * would leave its pane waiting for a tab that never comes, showing nothing; a pane opening on
 * its most recently used session instead is what the single-pane strip always did.
 */
interface PersistedLayout {
  preset: SplitPreset;
  focusedPane: PaneId;
  tabPane: Record<string, PaneId>;
}

/**
 * Read back defensively, the way `settings.json` is: written whole from memory, so a shape that
 * doesn't parse — or a value someone edited by hand — falls back to a fresh layout rather than
 * reaching a pane as garbage. Entries naming sessions that no longer exist are left in; see
 * `normalizeLayout` for why that is harmless and `saveLayout` for where they go.
 */
export function loadLayout(projectId: string): ProjectLayout {
  const fallback = defaultLayout();
  try {
    const raw = localStorage.getItem(layoutStorageKey(projectId, "layout"));
    if (raw === null) {
      return fallback;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return fallback;
    }
    const { preset, focusedPane, tabPane } = parsed as Record<string, unknown>;
    if (!isSplitPreset(preset) || !isPaneId(focusedPane)) {
      return fallback;
    }
    const restored: Record<string, PaneId> = {};
    if (tabPane !== null && typeof tabPane === "object") {
      for (const [sessionId, paneId] of Object.entries(tabPane)) {
        if (isPaneId(paneId)) {
          restored[sessionId] = paneId;
        }
      }
    }
    return { preset, focusedPane, tabPane: restored, activeTab: {} };
  } catch {
    return fallback;
  }
}

/**
 * The persisted form of a layout, given the tabs it currently describes — only those with a
 * session are written, under it (see `PersistedLayout`), so what is on disk never grows past
 * the tabs that exist and never names an id the next run could hand to a different tab.
 */
export function serializeLayout(layout: ProjectLayout, tabs: TerminalDescriptor[]): string {
  const tabPane: Record<string, PaneId> = {};
  for (const tab of tabs) {
    const paneId = layout.tabPane[tab.tabId];
    if (tab.sessionId !== undefined && paneId !== undefined) {
      tabPane[tab.sessionId] = paneId;
    }
  }
  const persisted: PersistedLayout = { preset: layout.preset, focusedPane: layout.focusedPane, tabPane };
  return JSON.stringify(persisted);
}

export function saveLayout(projectId: string, serialized: string): void {
  localStorage.setItem(layoutStorageKey(projectId, "layout"), serialized);
}
