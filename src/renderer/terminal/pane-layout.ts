import type { TerminalDescriptor } from "../../shared/types";
import { sameRecord } from "../identity";

/**
 * A terminal split view: fixed presets, not a nestable tree (CLAUDE.md, "Split view"). At most
 * four panes, so a letter identifies one; "a" is top left in every preset.
 */
export type PaneId = "a" | "b" | "c" | "d";
export const PANE_IDS: readonly PaneId[] = ["a", "b", "c", "d"];

/**
 * Single, two columns, two columns with the right one split, 2×2. No layout picker: a preset is
 * reached only by a snap (`SNAP_TRANSITIONS`) and left only by a collapse (`COLLAPSE_TRANSITIONS`).
 */
export type SplitPreset = "single" | "cols2" | "split-right" | "grid2x2";
/** Every preset — what a persisted layout is checked against. */
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

/** A position-based name for a pane, for "move to" entries and tooltips. */
export const PANE_LABELS: Record<SplitPreset, Partial<Record<PaneId, string>>> = {
  single: {},
  cols2: { a: "Left", b: "Right" },
  "split-right": { a: "Left", b: "Top Right", c: "Bottom Right" },
  grid2x2: { a: "Top Left", b: "Top Right", c: "Bottom Left", d: "Bottom Right" }
};

/**
 * What the layout reads of a tab: id, session (persistence), saved command (`placeCommandTab`),
 * last use (`pickActive`). The editor tab (`editor-tab.ts`) has only the id, so is never written.
 */
export type LayoutTab = Pick<TerminalDescriptor, "tabId" | "sessionId" | "command" | "updatedAt">;

/** A project's split state — held in `App`, not in `TerminalsPane` (see CLAUDE.md). */
export interface ProjectLayout {
  preset: SplitPreset;
  /** Where a new tab lands and what the tab shortcuts act on; keyboard focus follows it. */
  focusedPane: PaneId;
  /**
   * Which pane an open tab belongs to, by tab id — exactly one, since a tab has one xterm. Assigned
   * lazily — see `normalizeLayout`.
   */
  tabPane: Record<string, PaneId>;
  /** Each pane's own active tab. */
  activeTab: Partial<Record<PaneId, string | null>>;
  /**
   * Where each saved command's tab last lay, by command line — written on close (`normalizeLayout`),
   * read on rerun (`placeCommandTab`), persisted with the open ones merged (`serializeLayout`).
   * With the preset: a pane is a position only within its preset.
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

/** The tabs in front of the user: those shown, none while the window is unfocused or covered. */
export function tabsInFront(layout: ProjectLayout, focused: boolean, covered: boolean): string[] {
  return focused && !covered ? visibleTabIds(layout) : [];
}

/**
 * The project's active editor tab, given its editor tab ids: the one active in the focused pane,
 * else the first on screen, else `previous` while still open, else the last opened.
 */
export function activeEditorTab(layout: ProjectLayout, editorTabIds: string[], previous: string | undefined): string | undefined {
  const open = (tabId: string | null | undefined): tabId is string => tabId != null && editorTabIds.includes(tabId);
  return [layout.activeTab[layout.focusedPane], ...visibleTabIds(layout), previous].find(open) ?? editorTabIds.at(-1);
}

/** The tab a pane keeps active once `wanted` (its previous active tab) is gone from `list`. */
function pickActive(
  list: LayoutTab[],
  previousList: LayoutTab[],
  wanted: string | null | undefined
): string | null {
  if (wanted && list.some((tab) => tab.tabId === wanted)) {
    return wanted;
  }
  // Never in the list: a tab just activated whose push has not arrived. Kept, or the neighbour rule
  // steals its selection. Always an id of this run — `activeTab` is not persisted.
  if (wanted && !previousList.some((tab) => tab.tabId === wanted)) {
    return wanted;
  }
  if (list.length === 0) {
    return null;
  }
  if (!wanted) {
    // The pane's first: the session last worked in.
    return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0].tabId;
  }
  // Closed: VS Code's rule, the neighbour on the right, else the left.
  const index = previousList.findIndex((tab) => tab.tabId === wanted);
  return list[Math.min(Math.max(index, 0), list.length - 1)].tabId;
}

/**
 * The one place a layout is reconciled with the tab list: a tab seen for the first time goes to
 * the focused pane, each pane's active tab still exists, moves to a neighbour
 * in its pane, or becomes null. `tabPane` entries of closed tabs are dropped; `previousTabs` tells
 * "closed" from "not created yet" (`pickActive`).
 *
 * An entry for a tab in neither list is kept: sessions arrive agent by agent at startup. One that
 * never comes lasts until the next `saveLayout`, which writes only what exists.
 *
 * Returns `layout` itself when nothing changed: a new object re-renders every memoized view.
 */
export function normalizeLayout(
  layout: ProjectLayout,
  tabs: LayoutTab[],
  previousTabs: LayoutTab[]
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
  // A new tab settles in the focused pane — written now, so it does not follow the focus later.
  for (const tab of tabs) {
    tabPane[tab.tabId] ??= layout.focusedPane;
  }
  const listOf = (source: LayoutTab[], paneId: PaneId): LayoutTab[] =>
    source.filter((tab) => (tabPane[tab.tabId] ?? layout.focusedPane) === paneId);
  const activeTab: Partial<Record<PaneId, string | null>> = {};
  for (const paneId of panes) {
    activeTab[paneId] = pickActive(listOf(tabs, paneId), listOf(previousTabs, paneId), layout.activeTab[paneId]);
  }
  const focusedPane = panes.includes(layout.focusedPane) ? layout.focusedPane : panes[0];
  // A closing saved command's tab records its pane under its command line.
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

/** Which pane of the new preset each pane of the old one becomes; one left out keeps its letter. */
type PaneRemap = Partial<Record<PaneId, PaneId>>;

/**
 * The one way a preset changes under existing tabs: tabs, active tab and focus follow `remap`; a
 * pane the new preset lacks and `remap` omits hands everything to "a". Re-normalized at once.
 */
function retarget(layout: ProjectLayout, preset: SplitPreset, remap: PaneRemap, tabs: LayoutTab[]): ProjectLayout {
  const panes = PRESET_PANES[preset];
  const paneFor = (paneId: PaneId): PaneId => remap[paneId] ?? (panes.includes(paneId) ? paneId : "a");
  const tabPane = Object.fromEntries(Object.entries(layout.tabPane).map(([tabId, paneId]) => [tabId, paneFor(paneId)]));
  const activeTab: Partial<Record<PaneId, string | null>> = {};
  for (const [paneId, tabId] of Object.entries(layout.activeTab) as [PaneId, string | null][]) {
    // A remapped pane's selection outranks that of the (emptied) pane whose letter it takes. A pane
    // falling to "a" brings none: a keeps its own, or picks afresh.
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
 * A tab becomes `target`'s active one — a click, a move, a new tab — written whether or not it has
 * arrived in `tabs` (`normalizeLayout` leaves a pending one alone). Focus follows. The source pane
 * falls back to the tab before it, else the first, else null.
 */
export function moveTab(layout: ProjectLayout, tabId: string, target: PaneId, tabs: LayoutTab[]): ProjectLayout {
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
function occupiedPanes(layout: ProjectLayout, tabs: LayoutTab[]): PaneId[] {
  const held = new Set(tabs.map((tab) => paneOf(layout, tab.tabId)));
  return PRESET_PANES[layout.preset].filter((paneId) => held.has(paneId));
}

/**
 * What a preset falls to once a pane is *emptied* (last tab moved out or closed): that pane goes,
 * every other keeps its place, empty or not. Two panes left is cols2, however arranged; grid2x2
 * with b or d emptied has no "split-left" and stays. A never-filled pane is not emptied, so a
 * snap's empty panes stay. Not by occupied count: moving c into an empty d would collapse b.
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
 * What goes along with a collapse: every empty pane at the *end* of the reading order, the
 * occupied ones taking the room. An empty pane *before* an occupied one stays, so a tab moved
 * bottom right stays there. Repeated after each removal: taking bottom left out of the grid is
 * what brings the right column into a split-right.
 */
function collapseTrailing(layout: ProjectLayout, tabs: LayoutTab[]): ProjectLayout {
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
export function collapseEmptied(layout: ProjectLayout, emptied: PaneId, tabs: LayoutTab[]): ProjectLayout {
  const transition = COLLAPSE_TRANSITIONS[layout.preset][emptied];
  return transition ? collapseTrailing(retarget(layout, transition.preset, transition.remap, tabs), tabs) : layout;
}

/**
 * `moveTab`, plus the collapse when it emptied the source pane. Judged against `tabs`: a tab
 * activated ahead of its push resolves (`paneOf`) to the focused pane, which may already be empty.
 * `snapTab` is the same move without the collapse.
 */
export function activateTab(layout: ProjectLayout, tabId: string, target: PaneId, tabs: LayoutTab[]): ProjectLayout {
  const source = paneOf(layout, tabId);
  const moved = moveTab(layout, tabId, target, tabs);
  const emptied = occupiedPanes(layout, tabs).includes(source) && !occupiedPanes(moved, tabs).includes(source);
  return emptied ? collapseEmptied(moved, source, tabs) : moved;
}

/**
 * `normalizeLayout` for a tab list push, plus the collapse of every pane that held a tab of
 * `previousTabs` and holds none of `tabs`.
 */
export function collapseClosed(
  layout: ProjectLayout,
  tabs: LayoutTab[],
  previousTabs: LayoutTab[]
): ProjectLayout {
  const held = new Set(tabs.map((tab) => paneOf(layout, tab.tabId)));
  const emptied = PRESET_PANES[layout.preset].filter(
    (paneId) => !held.has(paneId) && previousTabs.some((tab) => paneOf(layout, tab.tabId) === paneId)
  );
  return collapsePanes(normalizeLayout(layout, tabs, previousTabs), emptied, tabs);
}

/**
 * The collapse once a project's bootstrap has listed every session: every empty pane counts as
 * emptied, a snap's included. What the transitions cannot take (the grid's b or d) stays.
 */
export function collapseEmpty(layout: ProjectLayout, tabs: LayoutTab[]): ProjectLayout {
  const occupied = occupiedPanes(layout, tabs);
  return collapsePanes(
    layout,
    PRESET_PANES[layout.preset].filter((paneId) => !occupied.includes(paneId)),
    tabs
  );
}

/**
 * Several emptied panes in reading order, each later letter translated through the collapse
 * before it; what trails is taken once at the end. `layout` itself when nothing collapsed.
 */
function collapsePanes(layout: ProjectLayout, emptied: PaneId[], tabs: LayoutTab[]): ProjectLayout {
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
 * Where a dragged tab asks for a pane at that position. The same for every preset: the right
 * quarter in thirds, the lower half of the left quarter; top left is "a", never a zone. Without a
 * `SNAP_TRANSITIONS` entry it is a plain drop. A quarter, not a half: in cols2 a half would cover
 * all of b. Tuned by hand against the real drag.
 */
export type SnapZone = "right" | "top-right" | "bottom-right" | "bottom-left";
export const SNAP_ZONES: Record<SnapZone, FractionBox> = {
  "top-right": { left: 3 / 4, top: 0, width: 1 / 4, height: 1 / 3 },
  right: { left: 3 / 4, top: 1 / 3, width: 1 / 4, height: 1 / 3 },
  "bottom-right": { left: 3 / 4, top: 2 / 3, width: 1 / 4, height: 1 / 3 },
  "bottom-left": { left: 0, top: 1 / 2, width: 1 / 4, height: 1 / 2 }
};

/**
 * What a zone does: the tab lands in `target`, `remap` renames panes, the rest keep their letter.
 * The preset is the smallest with a pane there; panes it adds beyond the target stay empty. Unlike
 * a plain drop, which *moves* (`collapseEmptied`), a zone drop *places* (`snapTab` never
 * collapses). cols2's top-right is the one zone moving existing tabs: b goes below.
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
 * The three divider lines as shares of `.panes-grid`. Per *line*, not per preset, so a preset
 * switch moves no line.
 */
export interface DividerShares {
  col: number;
  rowLeft: number;
  rowRight: number;
}

/** Each pane's box given the lines — the preview of the pane a drop would add. */
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
 * A tab dropped on a snap zone: preset switch and move in one state write, so the tab never renders
 * in the focused pane between. No collapse, unlike `activateTab`: the user asked for this layout.
 */
export function snapTab(
  layout: ProjectLayout,
  tabId: string,
  transition: SnapTransition,
  tabs: LayoutTab[]
): ProjectLayout {
  return moveTab(retarget(layout, transition.preset, transition.remap, tabs), tabId, transition.target, tabs);
}

/**
 * "The same pane" across presets: letters agree except bottom right (c in split-right, d in the
 * grid); a full-height a or b is the top of its column.
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
 * A saved command's new tab goes beside an open tab of the same command, else to the recorded
 * place — the same position in the current preset, or the recorded preset restored like a snap.
 * Placed, so nothing collapses. A command never run goes to the focused pane.
 */
export function placeCommandTab(
  layout: ProjectLayout,
  tabId: string,
  command: string,
  tabs: LayoutTab[]
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
 * How far past its zone the pointer may stray; stops the preview flickering between two zones.
 * Tuned by hand against the real drag.
 */
const SNAP_STICKY = 0.03;

/**
 * The snap zone under `point` (grid fractions), `active` keeping its margin — only zones the
 * preset has an entry for. Not asked over a tab strip.
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
 * `localStorage` under `Sash.tsx`'s `tet.layout.` namespace: layout describes the window, not the
 * repository. Per project, unlike `usePaneSize`/`usePaneToggle`'s fixed keys. `suffix` tells the
 * layout from `TerminalsPane`'s divider positions.
 */
export function layoutStorageKey(projectId: string, suffix: string): string {
  return `tet.layout.terminals.${projectId}.${suffix}`;
}

/**
 * What survives a restart: preset, focused pane, each tab's pane — keyed by *session id*. A new
 * tab's `new-N` id restarts from zero each run and returns, if at all, under its session id. So
 * both are one entry, and what cannot return (a shell tab, no session persisted) is dropped.
 * The divider shares are persisted beside it (`useDividerFraction`).
 *
 * Not each pane's active tab: a stale one (session deleted between runs) would leave its pane
 * waiting for a tab that never comes.
 */
interface PersistedLayout {
  preset: SplitPreset;
  focusedPane: PaneId;
  tabPane: Record<string, PaneId>;
  /** Where each saved command last lay — the closed ones as recorded, the open ones as they are. */
  commandPane: Record<string, CommandPlace>;
}

/**
 * Read defensively: a bad shape falls back to a fresh layout. Entries of vanished sessions stay
 * (`normalizeLayout`). Session ids come back as tab ids, hence the editor tab's unlike id.
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
 * Only tabs with a session are written, under it (`PersistedLayout`), so disk never names an id
 * the next run could hand to another tab.
 */
export function serializeLayout(layout: ProjectLayout, tabs: LayoutTab[]): string {
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
