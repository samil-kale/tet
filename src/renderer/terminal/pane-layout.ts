import type { TerminalDescriptor } from "../../shared/types";
import { sameRecord } from "../identity";

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
  return retarget(layout, preset, {}, tabs);
}

/** Which pane of the new preset each pane of the old one becomes; one left out keeps its letter. */
type PaneRemap = Partial<Record<PaneId, PaneId>>;

/**
 * The one way a preset changes underneath existing tabs: every pane's tabs, its active tab and
 * the focus follow `remap`; a pane the new preset does not have and `remap` does not name hands
 * everything to "a" (`applyPreset`'s own rule). Re-normalized at once so the new preset's panes
 * have a valid active tab immediately rather than waiting for the next tab list push.
 */
function retarget(layout: ProjectLayout, preset: SplitPreset, remap: PaneRemap, tabs: TerminalDescriptor[]): ProjectLayout {
  const panes = PRESET_PANES[preset];
  const paneFor = (paneId: PaneId): PaneId => remap[paneId] ?? (panes.includes(paneId) ? paneId : "a");
  const tabPane = Object.fromEntries(Object.entries(layout.tabPane).map(([tabId, paneId]) => [tabId, paneFor(paneId)]));
  const activeTab: Partial<Record<PaneId, string | null>> = {};
  for (const [paneId, tabId] of Object.entries(layout.activeTab) as [PaneId, string | null][]) {
    // A remapped pane's selection outranks that of the pane whose letter it takes over — that
    // pane is one the switch is emptying (a collapse hands c's tabs to an a with nothing left).
    // A pane falling to "a" brings no selection along: a has its own, or picks one afresh.
    const target = remap[paneId];
    if (target !== undefined) {
      activeTab[target] = tabId;
    } else if (panes.includes(paneId) && activeTab[paneId] === undefined) {
      activeTab[paneId] = tabId;
    }
  }
  return normalizeLayout({ preset, focusedPane: paneFor(layout.focusedPane), tabPane, activeTab }, tabs, tabs);
}

/**
 * A tab becomes the active one of `target` — a click on it, a drag or a context menu moving it
 * into another pane, or a tab just created. Written blindly, whether or not the tab has arrived
 * in `tabs` yet — `normalizeLayout` is what leaves a pending one alone instead of treating it as
 * closed. Keyboard focus follows it.
 *
 * Moving a pane's own active tab elsewhere would otherwise leave that pane's `activeTab` naming
 * a tab it no longer has — nothing selected there until the user clicks something themselves.
 * The pane that loses it falls back to whichever tab sat right before it in its own order (the
 * one before wins over VS Code's "closed tab" rule of nearest-right-else-left, since here the
 * tab has not closed, just left; before is the one glance back to where it a moment ago sat next
 * to), or the first of what is left if it was that pane's own first tab, or nothing once the
 * pane is left with no tabs of its own at all.
 */
export function moveTab(layout: ProjectLayout, tabId: string, target: PaneId, tabs: TerminalDescriptor[]): ProjectLayout {
  const source = paneOf(layout, tabId);
  let activeTab = layout.activeTab;
  if (target !== source && layout.activeTab[source] === tabId) {
    const sourceTabs = tabs.filter((tab) => paneOf(layout, tab.tabId) === source);
    const index = sourceTabs.findIndex((tab) => tab.tabId === tabId);
    const remaining = sourceTabs.filter((tab) => tab.tabId !== tabId);
    activeTab = { ...activeTab, [source]: remaining.length > 0 ? remaining[Math.max(index - 1, 0)].tabId : null };
  }
  return {
    ...layout,
    focusedPane: target,
    tabPane: layout.tabPane[tabId] === target ? layout.tabPane : { ...layout.tabPane, [tabId]: target },
    activeTab: { ...activeTab, [target]: tabId }
  };
}

/** The panes holding at least one of `tabs`, in the preset's reading order. */
export function occupiedPanes(layout: ProjectLayout, tabs: TerminalDescriptor[]): PaneId[] {
  const held = new Set(tabs.map((tab) => paneOf(layout, tab.tabId)));
  return PRESET_PANES[layout.preset].filter((paneId) => held.has(paneId));
}

/**
 * The preset a layout settles into once a move or a close has left it with fewer occupied
 * panes — Zellij's swap layouts rather than VS Code's "close empty groups": the *number* of
 * occupied panes picks the preset, not which pane went empty. Two are cols2 and one is single,
 * whatever they were before; three out of the grid become split-right, since no row of the
 * grid can hold three; occupied panes keep their reading order. So there is no table of
 * "which empty pane collapses to what", no grid corner with no preset to fall to, and no
 * difference between a pane that was never filled and one that was emptied.
 *
 * Only ever asked when that number *fell* (`App`'s two triggers: a move, a tab list push).
 * That is what keeps a snap out of it without an exception of its own: a snap moves one tab into
 * a new pane, so the count never falls, and the empty panes it lays out stay until a later move
 * or close actually shrinks what is occupied. The picker stays out too — a preset the user just
 * chose is not up for settling, whatever it holds.
 */
export function settleLayout(layout: ProjectLayout, tabs: TerminalDescriptor[]): ProjectLayout {
  const occupied = occupiedPanes(layout, tabs);
  const preset: SplitPreset =
    occupied.length <= 1
      ? "single"
      : occupied.length === 2
        ? "cols2"
        : occupied.length === 3 && layout.preset === "grid2x2"
          ? "split-right"
          : layout.preset;
  const panes = PRESET_PANES[preset];
  if (preset === layout.preset && occupied.every((paneId, index) => paneId === panes[index])) {
    return layout;
  }
  const remap: PaneRemap = {};
  occupied.forEach((paneId, index) => {
    remap[paneId] = panes[index];
  });
  return retarget(layout, preset, remap, tabs);
}

/** A box as fractions of `.panes-grid` — the unit both the snap zones and the preview use. */
export interface FractionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a dragged tab can ask for a pane that is not there yet, named for the position the tab
 * would take. A map of the whole split, the same for every preset: the right quarter in thirds,
 * the lower half of the left quarter. Top left is never a zone — that is pane "a", which every
 * preset has. What a zone *does* depends on the preset (`SNAP_TRANSITIONS`); a zone with no
 * entry there is an ordinary drop into the pane under the pointer. A quarter, not the half the
 * layout itself splits at: in cols2 the zones would otherwise cover all of b, leaving only its
 * tab strip to drop a plain move on. Set by hand against the real drag.
 */
export type SnapZone = "right" | "top-right" | "bottom-right" | "bottom-left";
export const SNAP_ZONES: Record<SnapZone, FractionBox> = {
  "top-right": { left: 3 / 4, top: 0, width: 1 / 4, height: 1 / 3 },
  right: { left: 3 / 4, top: 1 / 3, width: 1 / 4, height: 1 / 3 },
  "bottom-right": { left: 3 / 4, top: 2 / 3, width: 1 / 4, height: 1 / 3 },
  "bottom-left": { left: 0, top: 1 / 2, width: 1 / 4, height: 1 / 2 }
};

/**
 * The preset switch a zone proposes: the tab lands in `target`, existing panes are renamed by
 * `remap`, everything else keeps its letter. The preset is the smallest one with a pane at that
 * position — panes it adds beyond the target stay empty (single dropped bottom-right is a
 * split-right with nothing top-right yet). The one zone that moves tabs already there is
 * cols2's top-right: b already sits there, so its tabs make room by going below.
 */
export interface SnapTransition {
  preset: SplitPreset;
  target: PaneId;
  remap: PaneRemap;
}

export const SNAP_TRANSITIONS: Record<SplitPreset, Partial<Record<SnapZone, SnapTransition>>> = {
  single: {
    right: { preset: "cols2", target: "b", remap: {} },
    "top-right": { preset: "split-right", target: "b", remap: {} },
    "bottom-right": { preset: "split-right", target: "c", remap: {} },
    "bottom-left": { preset: "grid2x2", target: "c", remap: {} }
  },
  cols2: {
    right: { preset: "cols3", target: "c", remap: {} },
    "top-right": { preset: "split-right", target: "b", remap: { b: "c" } },
    "bottom-right": { preset: "split-right", target: "c", remap: {} },
    "bottom-left": { preset: "grid2x2", target: "c", remap: {} }
  },
  // Three columns and the grid have nowhere left to add a pane.
  cols3: {},
  "split-right": { "bottom-left": { preset: "grid2x2", target: "c", remap: { c: "d" } } },
  grid2x2: {}
};

/**
 * Each pane's box at even shares — what the preview draws for the pane a drop would add. A
 * hint, not a measurement: the real dividers may sit elsewhere, and the drop lays the panes
 * out for real.
 */
export const PANE_BOXES: Record<SplitPreset, Partial<Record<PaneId, FractionBox>>> = {
  single: { a: { left: 0, top: 0, width: 1, height: 1 } },
  cols2: {
    a: { left: 0, top: 0, width: 1 / 2, height: 1 },
    b: { left: 1 / 2, top: 0, width: 1 / 2, height: 1 }
  },
  cols3: {
    a: { left: 0, top: 0, width: 1 / 3, height: 1 },
    b: { left: 1 / 3, top: 0, width: 1 / 3, height: 1 },
    c: { left: 2 / 3, top: 0, width: 1 / 3, height: 1 }
  },
  "split-right": {
    a: { left: 0, top: 0, width: 1 / 2, height: 1 },
    b: { left: 1 / 2, top: 0, width: 1 / 2, height: 1 / 2 },
    c: { left: 1 / 2, top: 1 / 2, width: 1 / 2, height: 1 / 2 }
  },
  grid2x2: {
    a: { left: 0, top: 0, width: 1 / 2, height: 1 / 2 },
    b: { left: 1 / 2, top: 0, width: 1 / 2, height: 1 / 2 },
    c: { left: 0, top: 1 / 2, width: 1 / 2, height: 1 / 2 },
    d: { left: 1 / 2, top: 1 / 2, width: 1 / 2, height: 1 / 2 }
  }
};

/**
 * A tab dropped on a snap zone: the preset switch and the move into the new pane as one layout
 * for one state write, so the tab never sits in the focused pane for a render in between, and
 * nothing is persisted twice. Never settled (`settleLayout`): the count of occupied panes does
 * not fall here, so the empty panes it lays out stay — the user asked for this layout.
 */
export function snapTab(
  layout: ProjectLayout,
  tabId: string,
  transition: SnapTransition,
  tabs: TerminalDescriptor[]
): ProjectLayout {
  return moveTab(retarget(layout, transition.preset, transition.remap, tabs), tabId, transition.target, tabs);
}

/**
 * How far past a zone's boundary the pointer may stray before the zone goes out — without it
 * the preview flickers with every pixel while the pointer rests on the line between two zones.
 * Set by hand against the real drag.
 */
const SNAP_STICKY = 0.03;

/**
 * The snap zone under a pointer at `point` (fractions of the grid, 0–1 on both axes), given the
 * zone shown right now (`active`, for the margin above) — only zones the preset has an entry
 * for. Where the pointer is over a tab strip the caller does not ask: a strip is where a plain
 * move is dropped.
 */
export function snapZoneAt(
  preset: SplitPreset,
  point: { x: number; y: number },
  active: SnapZone | null
): { zone: SnapZone; transition: SnapTransition } | null {
  const inside = (box: FractionBox, margin: number): boolean =>
    point.x >= box.left - margin &&
    point.x <= box.left + box.width + margin &&
    point.y >= box.top - margin &&
    point.y <= box.top + box.height + margin;
  const activeTransition = active && SNAP_TRANSITIONS[preset][active];
  if (active && activeTransition && inside(SNAP_ZONES[active], SNAP_STICKY)) {
    return { zone: active, transition: activeTransition };
  }
  for (const [zone, transition] of Object.entries(SNAP_TRANSITIONS[preset]) as [SnapZone, SnapTransition][]) {
    if (inside(SNAP_ZONES[zone], 0)) {
      return { zone, transition };
    }
  }
  return null;
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
