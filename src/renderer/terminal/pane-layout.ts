import type { TerminalDescriptor } from "../../shared/types";
import { sameRecord } from "../identity";

/**
 * A terminal split view: a fixed set of presets, not a nestable tree (see CLAUDE.md, "Split
 * view"). At most four panes, so a letter is all the identity a pane needs.
 */
export type PaneId = "a" | "b" | "c" | "d";
export const PANE_IDS: readonly PaneId[] = ["a", "b", "c", "d"];

export type SplitPreset = "single" | "cols2" | "split-right" | "grid2x2";
/** Every preset, in the order the layout menu lists them. */
export const PRESETS: readonly SplitPreset[] = ["single", "cols2", "split-right", "grid2x2"];

function isPaneId(value: unknown): value is PaneId {
  return PANE_IDS.includes(value as PaneId);
}

function isSplitPreset(value: unknown): value is SplitPreset {
  return PRESETS.includes(value as SplitPreset);
}

/** A tab dragged onto another pane — its own MIME, so a dropped file is never mistaken for one. */
export const TAB_DRAG_TYPE = "application/x-tet-terminal-tab";

/** Which panes exist for a preset, in reading order — also the "move to" menu's order. */
export const PRESET_PANES: Record<SplitPreset, PaneId[]> = {
  single: ["a"],
  cols2: ["a", "b"],
  "split-right": ["a", "b", "c"],
  grid2x2: ["a", "b", "c", "d"]
};

export const PRESET_LABELS: Record<SplitPreset, string> = {
  single: "Single",
  cols2: "Two Columns",
  "split-right": "Two Columns, Right Split",
  grid2x2: "Grid (2x2)"
};

/** A position-based name for a pane, for "move to" entries and tooltips. */
export const PANE_LABELS: Record<SplitPreset, Partial<Record<PaneId, string>>> = {
  single: {},
  cols2: { a: "Left", b: "Right" },
  "split-right": { a: "Left", b: "Top Right", c: "Bottom Right" },
  grid2x2: { a: "Top Left", b: "Top Right", c: "Bottom Left", d: "Bottom Right" }
};

/** A project's split state — held in `App`, not in `TerminalsPane` (see CLAUDE.md). */
export interface ProjectLayout {
  preset: SplitPreset;
  /** Where a new tab lands and what the tab shortcuts act on; keyboard focus follows it. */
  focusedPane: PaneId;
  /** Which pane an open tab belongs to, by tab id. Assigned lazily — see `normalizeLayout`. */
  tabPane: Record<string, PaneId>;
  /** Each pane's own active tab. */
  activeTab: Partial<Record<PaneId, string | null>>;
  /**
   * Where each saved command's tab last lay, by command line — written when such a tab closes
   * (`normalizeLayout`), read when it runs again (`placeCommandTab`), persisted with the open ones
   * merged in (`serializeLayout`). Preset and pane: a pane is a position only within its preset.
   */
  commandPane: Record<string, CommandPlace>;
}

/** A pane of a preset — the two together name a position on screen. */
export interface CommandPlace {
  preset: SplitPreset;
  pane: PaneId;
}

export function defaultLayout(): ProjectLayout {
  return { preset: "single", focusedPane: "a", tabPane: {}, activeTab: {}, commandPane: {} };
}

/** Which pane a tab lives in; the focused pane for one never assigned yet. */
export function paneOf(layout: ProjectLayout, tabId: string): PaneId {
  return layout.tabPane[tabId] ?? layout.focusedPane;
}

/** Every tab currently shown, one per pane. */
export function visibleTabIds(layout: ProjectLayout): string[] {
  return Object.values(layout.activeTab).filter((id): id is string => id != null);
}

/**
 * The tabs in front of the user: those shown, but none while the window lacks the focus (another
 * window in front, or minimized) or a dialog covers it — a turn ending then was out of sight.
 */
export function tabsInFront(layout: ProjectLayout, focused: boolean, covered: boolean): string[] {
  return focused && !covered ? visibleTabIds(layout) : [];
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
  // Not in the list, but never was: a tab just activated whose own push has not arrived yet.
  // Left alone, or the neighbour rule would steal the selection from a tab about to exist. Only
  // ever an id set during this run — `activeTab` is not persisted (see `saveLayout`).
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
  // Closed for good: VS Code's rule, the nearest neighbour on the right, else on the left.
  const index = previousList.findIndex((tab) => tab.tabId === wanted);
  return list[Math.min(Math.max(index, 0), list.length - 1)].tabId;
}

/**
 * Reconciles a layout with the current tab list: every pane's active tab still exists, is
 * reassigned to a neighbour within its pane, or goes to null once the pane has nothing left.
 * `tabPane` entries for tabs gone for good are dropped; `previousTabs` tells "gone for good" from
 * "not created yet" (see `pickActive`).
 *
 * A `tabPane` entry for a tab in neither list is kept: sessions arrive agent by agent at startup,
 * so a restored entry may name a tab whose push has not come yet. One that never comes costs an
 * entry until the next `saveLayout`, which writes only what exists; `paneOf` is only asked about
 * tabs that do.
 *
 * Returns `layout` itself when nothing changed: a new object re-renders every memoized view the
 * layout reaches.
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
  // A tab with no pane yet settles in the focused pane when first seen — written now, so it
  // does not follow the focus afterwards.
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
  // A saved command's tab that just closed leaves its pane behind under its command line.
  let commandPane = layout.commandPane;
  for (const tab of previousTabs) {
    if (tab.command === undefined || currentIds.has(tab.tabId)) {
      continue;
    }
    const place: CommandPlace = { preset: layout.preset, pane: paneOf(layout, tab.tabId) };
    const known = commandPane[tab.command];
    if (known?.preset !== place.preset || known.pane !== place.pane) {
      commandPane = { ...commandPane, [tab.command]: place };
    }
  }
  const nextTabPane = sameRecord(layout.tabPane, tabPane);
  const nextActiveTab = sameRecord(layout.activeTab, activeTab);
  if (
    focusedPane === layout.focusedPane &&
    nextTabPane === layout.tabPane &&
    nextActiveTab === layout.activeTab &&
    commandPane === layout.commandPane
  ) {
    return layout;
  }
  return { preset: layout.preset, focusedPane, tabPane: nextTabPane, activeTab: nextActiveTab, commandPane };
}

/**
 * A preset switch: panes that no longer exist hand their tabs to pane "a", present in every
 * preset. Re-normalized at once, so the new panes have a valid active tab before the next push.
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
 * The one way a preset changes underneath existing tabs: tabs, active tab and focus follow
 * `remap`; a pane the new preset lacks and `remap` does not name hands everything to "a".
 * Re-normalized at once.
 */
function retarget(layout: ProjectLayout, preset: SplitPreset, remap: PaneRemap, tabs: TerminalDescriptor[]): ProjectLayout {
  const panes = PRESET_PANES[preset];
  const paneFor = (paneId: PaneId): PaneId => remap[paneId] ?? (panes.includes(paneId) ? paneId : "a");
  const tabPane = Object.fromEntries(Object.entries(layout.tabPane).map(([tabId, paneId]) => [tabId, paneFor(paneId)]));
  const activeTab: Partial<Record<PaneId, string | null>> = {};
  for (const [paneId, tabId] of Object.entries(layout.activeTab) as [PaneId, string | null][]) {
    // A remapped pane's selection outranks that of the pane whose letter it takes over (that pane
    // is being emptied). A pane falling to "a" brings no selection: a has its own, or picks afresh.
    const target = remap[paneId];
    if (target !== undefined) {
      activeTab[target] = tabId;
    } else if (panes.includes(paneId) && activeTab[paneId] === undefined) {
      activeTab[paneId] = tabId;
    }
  }
  return normalizeLayout(
    { preset, focusedPane: paneFor(layout.focusedPane), tabPane, activeTab, commandPane: layout.commandPane },
    tabs,
    tabs
  );
}

/**
 * A tab becomes the active one of `target` — a click, a move, a new tab. Written blindly, whether
 * or not the tab has arrived in `tabs` (`normalizeLayout` leaves a pending one alone). Keyboard
 * focus follows it. The pane that loses its active tab falls back to the tab before it in its own
 * order, else the first, else null.
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

/** The panes holding at least one of `tabs`, in reading order. */
function occupiedPanes(layout: ProjectLayout, tabs: TerminalDescriptor[]): PaneId[] {
  const held = new Set(tabs.map((tab) => paneOf(layout, tab.tabId)));
  return PRESET_PANES[layout.preset].filter((paneId) => held.has(paneId));
}

/**
 * What a preset falls to once one of its panes is *emptied* (its last tab moved out or closed):
 * that pane goes, every other keeps its place, empty or not. Two panes left is cols2, whichever
 * way they were arranged; grid2x2 with b or d empty has no "split-left" to fall to and stays. A
 * pane never filled is not emptied: the empty panes a snap lays out stay. Not by count of
 * occupied panes: moving c into an empty d would collapse the untouched b.
 */
export const COLLAPSE_TRANSITIONS: Record<SplitPreset, Partial<Record<PaneId, { preset: SplitPreset; remap: PaneRemap }>>> = {
  single: {},
  cols2: { a: { preset: "single", remap: { b: "a" } }, b: { preset: "single", remap: {} } },
  "split-right": {
    a: { preset: "cols2", remap: { b: "a", c: "b" } },
    b: { preset: "cols2", remap: { c: "b" } },
    c: { preset: "cols2", remap: {} }
  },
  grid2x2: {
    a: { preset: "split-right", remap: { c: "a", d: "c" } },
    c: { preset: "split-right", remap: { d: "c" } }
  }
};

/**
 * What goes along with a collapse: every empty pane at the *end* of the reading order (LO, RO,
 * LU, RU), the occupied ones taking the room. An empty pane *before* an occupied one stays, so a
 * tab moved into RU stays bottom right. Run after the emptied pane has gone, and again after
 * each removal: taking LU out of the grid is what brings RO and RU into a split-right.
 */
function collapseTrailing(layout: ProjectLayout, tabs: TerminalDescriptor[]): ProjectLayout {
  let next = layout;
  for (;;) {
    const last = PRESET_PANES[next.preset].at(-1)!;
    if (occupiedPanes(next, tabs).includes(last) || !COLLAPSE_TRANSITIONS[next.preset][last]) {
      return next;
    }
    const transition = COLLAPSE_TRANSITIONS[next.preset][last]!;
    next = retarget(next, transition.preset, transition.remap, tabs);
  }
}

/** The whole collapse for one emptied pane: its own transition, then whatever trails. */
export function collapseEmptied(layout: ProjectLayout, emptied: PaneId, tabs: TerminalDescriptor[]): ProjectLayout {
  const transition = COLLAPSE_TRANSITIONS[layout.preset][emptied];
  return transition ? collapseTrailing(retarget(layout, transition.preset, transition.remap, tabs), tabs) : layout;
}

/**
 * `moveTab`, plus the collapse when the move took the last tab out of its pane. "Emptied" is
 * judged against `tabs`, not the pane the tab resolves to: a tab activated ahead of its push
 * resolves through `paneOf` to the focused pane, which may be empty without this move. A snap
 * (`snapTab`) is the same move without the collapse.
 */
export function activateTab(layout: ProjectLayout, tabId: string, target: PaneId, tabs: TerminalDescriptor[]): ProjectLayout {
  const source = paneOf(layout, tabId);
  const moved = moveTab(layout, tabId, target, tabs);
  const emptied = occupiedPanes(layout, tabs).includes(source) && !occupiedPanes(moved, tabs).includes(source);
  return emptied ? collapseEmptied(moved, source, tabs) : moved;
}

/**
 * `normalizeLayout` for a tab list push, plus the collapse for the tabs that *closed*: every pane
 * that held a tab of `previousTabs` and holds none of `tabs`. The normalized layout itself when
 * nothing closed.
 */
export function collapseClosed(
  layout: ProjectLayout,
  tabs: TerminalDescriptor[],
  previousTabs: TerminalDescriptor[]
): ProjectLayout {
  const held = new Set(tabs.map((tab) => paneOf(layout, tab.tabId)));
  const emptied = PRESET_PANES[layout.preset].filter(
    (paneId) => !held.has(paneId) && previousTabs.some((tab) => paneOf(layout, tab.tabId) === paneId)
  );
  return collapsePanes(normalizeLayout(layout, tabs, previousTabs), emptied, tabs);
}

/**
 * The collapse at startup, once a project's bootstrap has listed every session: every pane the
 * restored layout has nothing for counts as emptied, a snap's empty pane included. Stricter than
 * a run; what the transitions cannot take (the grid's b or d) still stays.
 */
export function collapseEmpty(layout: ProjectLayout, tabs: TerminalDescriptor[]): ProjectLayout {
  const occupied = occupiedPanes(layout, tabs);
  return collapsePanes(
    layout,
    PRESET_PANES[layout.preset].filter((paneId) => !occupied.includes(paneId)),
    tabs
  );
}

/**
 * Several panes emptied at once, in reading order, each later letter translated through the
 * collapse before it; what trails is taken once at the end. `layout` itself when nothing collapsed.
 */
function collapsePanes(layout: ProjectLayout, emptied: PaneId[], tabs: TerminalDescriptor[]): ProjectLayout {
  let next = layout;
  let pending = emptied;
  while (pending.length > 0) {
    const [paneId, ...rest] = pending;
    const transition = COLLAPSE_TRANSITIONS[next.preset][paneId];
    if (!transition) {
      pending = rest;
      continue;
    }
    next = retarget(next, transition.preset, transition.remap, tabs);
    pending = rest.map((id) => transition.remap[id] ?? id).filter((id) => PRESET_PANES[transition.preset].includes(id));
  }
  return next === layout ? layout : collapseTrailing(next, tabs);
}

/** A box as fractions of `.panes-grid` — the unit of the snap zones and the preview. */
export interface FractionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a dragged tab can ask for a pane that is not there yet, named for the position it would
 * take. The same map for every preset: the right quarter in thirds, the lower half of the left
 * quarter; top left is pane "a", never a zone. What a zone does is `SNAP_TRANSITIONS`; without an
 * entry it is a plain drop into the pane under the pointer. A quarter, not the half the layout
 * splits at: in cols2 the zones would otherwise cover all of b. Set by hand against the real
 * drag.
 */
export type SnapZone = "right" | "top-right" | "bottom-right" | "bottom-left";
export const SNAP_ZONES: Record<SnapZone, FractionBox> = {
  "top-right": { left: 3 / 4, top: 0, width: 1 / 4, height: 1 / 3 },
  right: { left: 3 / 4, top: 1 / 3, width: 1 / 4, height: 1 / 3 },
  "bottom-right": { left: 3 / 4, top: 2 / 3, width: 1 / 4, height: 1 / 3 },
  "bottom-left": { left: 0, top: 1 / 2, width: 1 / 4, height: 1 / 2 }
};

/**
 * What a zone does: the tab lands in `target`, existing panes are renamed by `remap`, the rest
 * keep their letter. The preset is the smallest with a pane at that position; panes it adds
 * beyond the target stay empty. Where the preset already has that pane, the zone is the pane
 * itself; the difference to a plain drop is the source pane: a zone drop *places* (`snapTab`
 * never collapses), a plain drop *moves* (`collapseEmptied`). cols2's top-right is the one zone
 * that moves tabs already there: b makes room by going below.
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
    right: { preset: "cols2", target: "b", remap: {} },
    "top-right": { preset: "split-right", target: "b", remap: { b: "c" } },
    "bottom-right": { preset: "split-right", target: "c", remap: {} },
    "bottom-left": { preset: "grid2x2", target: "c", remap: {} }
  },
  "split-right": {
    "top-right": { preset: "split-right", target: "b", remap: {} },
    "bottom-right": { preset: "split-right", target: "c", remap: {} },
    "bottom-left": { preset: "grid2x2", target: "c", remap: { c: "d" } }
  },
  grid2x2: {
    "top-right": { preset: "grid2x2", target: "b", remap: {} },
    "bottom-right": { preset: "grid2x2", target: "d", remap: {} },
    "bottom-left": { preset: "grid2x2", target: "c", remap: {} }
  }
};

/**
 * Where the three divider lines sit, as shares of `.panes-grid`. One share per *line*, not per
 * preset: `TerminalsPane` sizes every preset from the same three, so a preset switch moves no line.
 */
export interface DividerShares {
  col: number;
  rowLeft: number;
  rowRight: number;
}

/**
 * Each pane's box given the lines — what the preview draws for the pane a drop would add. Fed the
 * live shares, it is that pane's real box after the drop.
 */
const PANE_BOXES: Record<SplitPreset, Partial<Record<PaneId, (shares: DividerShares) => FractionBox>>> = {
  single: { a: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
  cols2: {
    a: ({ col }) => ({ left: 0, top: 0, width: col, height: 1 }),
    b: ({ col }) => ({ left: col, top: 0, width: 1 - col, height: 1 })
  },
  "split-right": {
    a: ({ col }) => ({ left: 0, top: 0, width: col, height: 1 }),
    b: ({ col, rowRight }) => ({ left: col, top: 0, width: 1 - col, height: rowRight }),
    c: ({ col, rowRight }) => ({ left: col, top: rowRight, width: 1 - col, height: 1 - rowRight })
  },
  grid2x2: {
    a: ({ col, rowLeft }) => ({ left: 0, top: 0, width: col, height: rowLeft }),
    b: ({ col, rowRight }) => ({ left: col, top: 0, width: 1 - col, height: rowRight }),
    c: ({ col, rowLeft }) => ({ left: 0, top: rowLeft, width: col, height: 1 - rowLeft }),
    d: ({ col, rowRight }) => ({ left: col, top: rowRight, width: 1 - col, height: 1 - rowRight })
  }
};

export function paneBox(preset: SplitPreset, paneId: PaneId, shares: DividerShares): FractionBox | null {
  return PANE_BOXES[preset][paneId]?.(shares) ?? null;
}

/**
 * A tab dropped on a snap zone: preset switch and move as one layout for one state write, so the
 * tab never sits in the focused pane for a render in between. No collapse, unlike `activateTab`:
 * the source pane and the panes the preset adds stay — the user asked for this layout.
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
 * Where a pane sits on screen — "the same pane" across presets: the letters agree except bottom
 * right (c in split-right, d in the grid), and a full-height a or b counts as the top of its column.
 */
type PanePosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const PANE_POSITIONS: Record<SplitPreset, Partial<Record<PaneId, PanePosition>>> = {
  single: { a: "top-left" },
  cols2: { a: "top-left", b: "top-right" },
  "split-right": { a: "top-left", b: "top-right", c: "bottom-right" },
  grid2x2: { a: "top-left", b: "top-right", c: "bottom-left", d: "bottom-right" }
};

function paneAt(preset: SplitPreset, position: PanePosition | undefined): PaneId | undefined {
  return PRESET_PANES[preset].find((paneId) => PANE_POSITIONS[preset][paneId] === position);
}

/**
 * A saved command's tab, just opened, goes where that command last lay: beside an open tab of the
 * same command, else in the recorded pane — the one at the same position in the current preset,
 * or the recorded preset restored like a snap. Placed, not moved: nothing collapses. A command
 * never run before goes to the focused pane.
 */
export function placeCommandTab(
  layout: ProjectLayout,
  tabId: string,
  command: string,
  tabs: TerminalDescriptor[]
): ProjectLayout {
  const open = tabs.find((tab) => tab.command === command && tab.tabId !== tabId);
  const place = open ? { preset: layout.preset, pane: paneOf(layout, open.tabId) } : layout.commandPane[command];
  if (!place) {
    return moveTab(layout, tabId, paneOf(layout, tabId), tabs);
  }
  const position = PANE_POSITIONS[place.preset][place.pane];
  const pane = paneAt(layout.preset, position);
  if (pane) {
    return moveTab(layout, tabId, pane, tabs);
  }
  const remap: PaneRemap = {};
  for (const paneId of PRESET_PANES[layout.preset]) {
    const kept = paneAt(place.preset, PANE_POSITIONS[layout.preset][paneId]);
    if (kept !== undefined && kept !== paneId) {
      remap[paneId] = kept;
    }
  }
  return snapTab(layout, tabId, { preset: place.preset, target: place.pane, remap }, tabs);
}

/**
 * How far past a zone's boundary the pointer may stray before the zone goes out; without it the
 * preview flickers on the line between two zones. Set by hand against the real drag.
 */
const SNAP_STICKY = 0.03;

/**
 * The snap zone under `point` (fractions of the grid), given the zone shown now (`active`, for
 * the margin) — only zones the preset has an entry for. Over a tab strip the caller does not ask.
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
 * `localStorage`, under the `tet.layout.` namespace `Sash.tsx` uses: layout describes the window,
 * not the repository. Per project, so not `usePaneSize`/`usePaneToggle` (their key is fixed at
 * the call site). `suffix` tells the layout from the divider positions `TerminalsPane` keeps.
 */
export function layoutStorageKey(projectId: string, suffix: string): string {
  return `tet.layout.terminals.${projectId}.${suffix}`;
}

/**
 * What survives a restart: preset, focused pane, and which pane each tab lives in — keyed by
 * *session id*, not tab id. A tab created during a run has a `new-N` id handed out from zero at
 * every start, and comes back, if at all, under its session id (a restored tab's tab id). Keying
 * by session id makes both the same entry and drops what cannot return (a shell tab, an agent tab
 * whose CLI persisted no session).
 *
 * Not here: each pane's active tab. A stale one (a session deleted between runs) would leave its
 * pane waiting for a tab that never comes.
 */
interface PersistedLayout {
  preset: SplitPreset;
  focusedPane: PaneId;
  tabPane: Record<string, PaneId>;
  /** Where each saved command last lay — the closed ones as recorded, the open ones as they are. */
  commandPane: Record<string, CommandPlace>;
}

/**
 * Read back defensively, like `settings.json`: a shape that does not parse falls back to a fresh
 * layout. Entries naming sessions that no longer exist are left in (see `normalizeLayout`).
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
    const { preset, focusedPane, tabPane, commandPane } = parsed as Record<string, unknown>;
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
    const places: Record<string, CommandPlace> = {};
    if (commandPane !== null && typeof commandPane === "object") {
      for (const [command, place] of Object.entries(commandPane as Record<string, unknown>)) {
        const { preset: placePreset, pane } = (place ?? {}) as Record<string, unknown>;
        if (isSplitPreset(placePreset) && isPaneId(pane) && PRESET_PANES[placePreset].includes(pane)) {
          places[command] = { preset: placePreset, pane };
        }
      }
    }
    return { preset, focusedPane, tabPane: restored, activeTab: {}, commandPane: places };
  } catch {
    return fallback;
  }
}

/**
 * The persisted form, given the tabs it describes — only those with a session are written, under
 * it (see `PersistedLayout`), so disk never names an id the next run could hand to another tab.
 */
export function serializeLayout(layout: ProjectLayout, tabs: TerminalDescriptor[]): string {
  const tabPane: Record<string, PaneId> = {};
  // The open command tabs' panes over the recorded ones.
  const commandPane = { ...layout.commandPane };
  for (const tab of tabs) {
    const paneId = layout.tabPane[tab.tabId];
    if (tab.sessionId !== undefined && paneId !== undefined) {
      tabPane[tab.sessionId] = paneId;
    }
    if (tab.command !== undefined) {
      commandPane[tab.command] = { preset: layout.preset, pane: paneOf(layout, tab.tabId) };
    }
  }
  const persisted: PersistedLayout = { preset: layout.preset, focusedPane: layout.focusedPane, tabPane, commandPane };
  return JSON.stringify(persisted);
}

export function saveLayout(projectId: string, serialized: string): void {
  localStorage.setItem(layoutStorageKey(projectId, "layout"), serialized);
}
