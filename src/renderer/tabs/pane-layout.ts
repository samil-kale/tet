import { ownValue } from "../../shared/own-value";
import type { TabDescriptor } from "../../shared/types/terminals";
import { sameList, sameRecord } from "../identity";
import { layoutKey } from "../ui/layout-storage";
import { isEditorTabId, MARKDOWN_PREVIEW_MODES, type EditorEntry } from "../editor/editor-tab";

/**
 * The tab area's split view: fixed presets, not a nestable tree (AGENTS.md, "Split view"). At most
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
const PRESETS: readonly SplitPreset[] = ["single", "cols2", "split-right", "grid2x2"];

function isPaneId(value: unknown): value is PaneId {
  return PANE_IDS.includes(value as PaneId);
}

function isSplitPreset(value: unknown): value is SplitPreset {
  return PRESETS.includes(value as SplitPreset);
}

/** A tab dragged onto another pane — its own MIME, so a dropped file is never mistaken for one. */
export const TAB_DRAG_TYPE = "application/x-tet-tab";

/** Which panes exist for a preset, in reading order — also the "move to" menu's order. */
export const PRESET_PANES: Record<SplitPreset, PaneId[]> = {
  single: ["a"],
  cols2: ["a", "b"],
  "split-right": ["a", "b", "c"],
  grid2x2: ["a", "b", "c", "d"],
};

/** A position-based name for a pane, for "move to" entries and tooltips. */
export const PANE_LABELS: Record<SplitPreset, Partial<Record<PaneId, string>>> = {
  single: {},
  cols2: { a: "Left", b: "Right" },
  "split-right": { a: "Left", b: "Top Right", c: "Bottom Right" },
  grid2x2: { a: "Top Left", b: "Top Right", c: "Bottom Left", d: "Bottom Right" },
};

/**
 * What the layout reads of a tab: id, session and agent (persistence), saved command
 * (`placeCommandTab`), last use (`pickActive`). The editor tab (`editor-tab.ts`) has only the id,
 * written under it (`persistedOf`).
 */
export type LayoutTab = Pick<TabDescriptor, "tabId" | "sessionId" | "command" | "updatedAt"> & Partial<Pick<TabDescriptor, "agentId">>;

/** A shell of its own, no saved command: what the window brings back after a restart under its id
 *  (`use-tab-restore.ts`), as VS Code its terminals — a command is never run again unasked. */
export function isPlainShell(tab: LayoutTab): boolean {
  return tab.agentId === "shell" && tab.command === undefined;
}

/** A project's split state — held in `App`, not in `TabArea` (see AGENTS.md). */
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
   * Every tab's place in its strip, by tab id, all panes in one list (`inOrder`): moved by a drag
   * (`dropOnStrip`), a new tab placed beside its pane's active one as VS Code does (`normalizeLayout`).
   */
  order: string[];
  /**
   * The tabs last made active, the most recent first, all panes in one list: a pane whose active
   * tab closes or moves away shows its most recent other one, as VS Code does
   * (`workbench.editor.focusRecentEditorAfterClose`).
   */
  recent: string[];
  /**
   * Where each saved command's tab last lay, by command line — written on close (`normalizeLayout`),
   * read on rerun (`placeCommandTab`), persisted with the open ones merged (`serializeLayout`).
   * With the preset: a pane is a position only within its preset.
   */
  commandPane: Record<string, CommandPlace>;
}

/** A pane of a preset — the two together name a position on screen. */
interface CommandPlace {
  preset: SplitPreset;
  pane: PaneId;
}

/** Shared instance, so an empty `order` or `recent` keeps its identity. */
const NO_IDS: string[] = [];

export function defaultLayout(): ProjectLayout {
  return { preset: "single", focusedPane: "a", tabPane: {}, activeTab: {}, order: NO_IDS, recent: NO_IDS, commandPane: {} };
}

/** `tabs` as the strip shows them, by `order`; one it does not hold yet keeps its place behind. */
export function inOrder<T extends { tabId: string }>(order: readonly string[], tabs: T[]): T[] {
  const rank = new Map(order.map((tabId, index) => [tabId, index]));
  const rankOf = (tab: T): number => rank.get(tab.tabId) ?? order.length;
  return [...tabs].sort((a, b) => rankOf(a) - rankOf(b));
}

/** `order` with `tabId` taken out and put back before `before`, or at the end without one. */
function insertBefore(order: readonly string[], tabId: string, before: string | undefined): string[] {
  const rest = order.filter((id) => id !== tabId);
  const index = before === undefined ? -1 : rest.indexOf(before);
  rest.splice(index < 0 ? rest.length : index, 0, tabId);
  return rest;
}

/** `order` with `tabId` taken out and put back right after `after`, or at the end without one. */
function insertAfter(order: readonly string[], tabId: string, after: string | null | undefined): string[] {
  const rest = order.filter((id) => id !== tabId);
  const index = after == null ? -1 : rest.indexOf(after);
  return insertBefore(rest, tabId, index < 0 ? undefined : rest[index + 1]);
}

/** `recent` with `tabIds` made the most recent, the first of them most. */
function madeRecent(recent: readonly string[], tabIds: string[]): string[] {
  return [...tabIds, ...recent.filter((tabId) => !tabIds.includes(tabId))];
}

/** `sameList` for `order` and `recent`, an empty one kept as it is too. */
function sameIds(previous: string[], next: string[]): string[] {
  return sameList(previous, next, previous.length === 0 ? previous : NO_IDS);
}

/** Shared instance, read where a repository or worktree has no layout yet: stable for memoized views. */
export const DEFAULT_LAYOUT = defaultLayout();

/** Which pane a tab lives in; the focused pane for one never assigned yet. */
export function paneOf(layout: ProjectLayout, tabId: string): PaneId {
  return layout.tabPane[tabId] ?? layout.focusedPane;
}

/** Every tab currently shown, one per pane. */
export function visibleTabIds(layout: ProjectLayout): string[] {
  return Object.values(layout.activeTab).filter((id): id is string => id != null);
}

/** The tabs on screen: those shown, none while the window is unfocused or covered. */
export function tabsOnScreen(layout: ProjectLayout, focused: boolean, covered: boolean): string[] {
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

/**
 * The tab a pane keeps active once `wanted` (its previous active tab) is gone from `list`, the
 * pane's tabs in the strip's order; `recent` is the layout's.
 */
function pickActive(list: LayoutTab[], previousList: LayoutTab[], wanted: string | null | undefined, recent: string[]): string | null {
  if (wanted && list.some((tab) => tab.tabId === wanted)) {
    return wanted;
  }
  // Never in the list: a tab just activated whose push has not arrived, or a restored one whose
  // session is not listed yet. Kept, or the neighbour rule steals its selection; a restored one
  // that never comes is dropped once the project settles (`collapseEmpty`).
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
  // Closed: the pane's most recently active other tab, as VS Code picks it; where none was ever
  // active, the neighbour on the right, else the left.
  const mostRecent = recent.find((tabId) => list.some((tab) => tab.tabId === tabId));
  if (mostRecent !== undefined) {
    return mostRecent;
  }
  const index = previousList.findIndex((tab) => tab.tabId === wanted);
  return list[Math.min(Math.max(index, 0), list.length - 1)].tabId;
}

/**
 * The one place a layout is reconciled with the tab list: a tab seen for the first time goes to
 * the focused pane, each pane's active tab still exists, moves to the pane's most recent other
 * one, or becomes null. `tabPane` entries of closed tabs are dropped; `previousTabs` tells
 * "closed" from "not created yet" (`pickActive`).
 *
 * An entry for a tab in neither list is kept: sessions arrive agent by agent at startup. One that
 * never comes lasts until the next `serializeLayout`, which writes only what exists.
 *
 * A tab new to `order` goes right of its pane's active tab, as VS Code opens one; while `listing`
 * (the bootstrap's sessions arriving), where main lists it among the others instead.
 *
 * Returns `layout` itself when nothing changed: a new object re-renders every memoized view.
 */
export function normalizeLayout(layout: ProjectLayout, tabs: LayoutTab[], previousTabs: LayoutTab[], listing: boolean): ProjectLayout {
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
  // Before the new tabs settle: a restored focus can name a pane the preset lacks (`loadLayout`).
  const focusedPane = panes.includes(layout.focusedPane) ? layout.focusedPane : panes[0];
  // A new tab settles in the focused pane — written now, so it does not follow the focus later.
  for (const tab of tabs) {
    tabPane[tab.tabId] ??= focusedPane;
  }
  // Kept as `tabPane` is: still open, or not confirmed closed.
  const kept = (tabId: string): boolean => currentIds.has(tabId) || !previousIds.has(tabId);
  let order = layout.order.filter(kept);
  let recent = layout.recent.filter(kept);
  const placed = new Set(order);
  /** Per pane, the tab the next new one goes right of: its active one, then the one placed last. */
  const anchors: Partial<Record<PaneId, string | null>> = {};
  for (const [index, tab] of tabs.entries()) {
    if (placed.has(tab.tabId)) {
      continue;
    }
    if (listing) {
      order = insertBefore(order, tab.tabId, tabs.slice(index + 1).find((later) => placed.has(later.tabId))?.tabId);
    } else {
      const paneId = tabPane[tab.tabId];
      const active = layout.activeTab[paneId];
      const anchor = paneId in anchors ? anchors[paneId] : active && placed.has(active) ? active : null;
      order = insertAfter(order, tab.tabId, anchor);
      anchors[paneId] = tab.tabId;
    }
    placed.add(tab.tabId);
  }
  // Each list in the strip's order, the previous one by the previous order and assignment: a closed
  // tab's is dropped above.
  const listOf = (source: LayoutTab[], assignment: Record<string, PaneId>, sequence: string[], paneId: PaneId): LayoutTab[] =>
    inOrder(
      sequence,
      source.filter((tab) => (assignment[tab.tabId] ?? layout.focusedPane) === paneId),
    );
  const activeTab: Partial<Record<PaneId, string | null>> = {};
  for (const paneId of panes) {
    activeTab[paneId] = pickActive(
      listOf(tabs, tabPane, order, paneId),
      listOf(previousTabs, layout.tabPane, layout.order, paneId),
      layout.activeTab[paneId],
      recent,
    );
  }
  // A tab that became a pane's active one here is its most recent.
  const activated = panes
    .map((paneId) => activeTab[paneId])
    .filter((tabId, index): tabId is string => tabId != null && tabId !== layout.activeTab[panes[index]]);
  if (activated.length > 0) {
    recent = madeRecent(recent, activated);
  }
  // A closing saved command's tab records its pane under its command line.
  let commandPane = layout.commandPane;
  for (const tab of previousTabs) {
    if (tab.command === undefined || currentIds.has(tab.tabId)) {
      continue;
    }
    const place: CommandPlace = { preset: layout.preset, pane: paneOf(layout, tab.tabId) };
    const known = ownValue(commandPane, tab.command);
    if (known?.preset !== place.preset || known.pane !== place.pane) {
      commandPane = { ...commandPane, [tab.command]: place };
    }
  }
  const nextTabPane = sameRecord(layout.tabPane, tabPane);
  const nextActiveTab = sameRecord(layout.activeTab, activeTab);
  const nextOrder = sameIds(layout.order, order);
  const nextRecent = sameIds(layout.recent, recent);
  if (
    focusedPane === layout.focusedPane &&
    nextTabPane === layout.tabPane &&
    nextActiveTab === layout.activeTab &&
    nextOrder === layout.order &&
    nextRecent === layout.recent &&
    commandPane === layout.commandPane
  ) {
    return layout;
  }
  return {
    preset: layout.preset,
    focusedPane,
    tabPane: nextTabPane,
    activeTab: nextActiveTab,
    order: nextOrder,
    recent: nextRecent,
    commandPane,
  };
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
    {
      preset,
      focusedPane: paneFor(layout.focusedPane),
      tabPane,
      activeTab,
      order: layout.order,
      recent: layout.recent,
      commandPane: layout.commandPane,
    },
    tabs,
    tabs,
    false,
  );
}

/**
 * A tab becomes `target`'s active one — a click, a move, a new tab — written whether or not it has
 * arrived in `tabs` (`normalizeLayout` leaves a pending one alone), and its most recent. Focus
 * follows. The source pane falls back as on a close (`pickActive`). A tab new to `order`, or moved
 * to another pane, goes right of `target`'s active one, as VS Code opens one (`normalizeLayout`
 * places one arriving first); a drop on a strip puts it where it fell (`dropOnStrip`).
 */
export function moveTab(layout: ProjectLayout, tabId: string, target: PaneId, tabs: LayoutTab[]): ProjectLayout {
  const source = paneOf(layout, tabId);
  let activeTab = layout.activeTab;
  const shown = [tabId];
  if (target !== source && layout.activeTab[source] === tabId) {
    const sourceTabs = inOrder(
      layout.order,
      tabs.filter((tab) => paneOf(layout, tab.tabId) === source),
    );
    const next = pickActive(
      sourceTabs.filter((tab) => tab.tabId !== tabId),
      sourceTabs,
      tabId,
      layout.recent,
    );
    activeTab = { ...activeTab, [source]: next };
    if (next !== null) {
      shown.push(next);
    }
  }
  const placed = layout.order.includes(tabId) && target === source;
  return {
    ...layout,
    focusedPane: target,
    tabPane: layout.tabPane[tabId] === target ? layout.tabPane : { ...layout.tabPane, [tabId]: target },
    activeTab: { ...activeTab, [target]: tabId },
    order: placed ? layout.order : insertAfter(layout.order, tabId, layout.activeTab[target]),
    recent: sameIds(layout.recent, madeRecent(layout.recent, shown)),
  };
}

/**
 * A tab dropped on `paneId`'s strip: shown there as `activateTab` shows it, and put right before
 * `before`, or behind the pane's last tab without one. The last is found first, as the drop's pane
 * may change its letter when the source pane collapses.
 */
export function dropOnStrip(
  layout: ProjectLayout,
  tabId: string,
  paneId: PaneId,
  before: string | undefined,
  tabs: LayoutTab[],
): ProjectLayout {
  const last = inOrder(
    layout.order,
    tabs.filter((tab) => tab.tabId !== tabId && paneOf(layout, tab.tabId) === paneId),
  ).at(-1)?.tabId;
  const shown = activateTab(layout, tabId, paneId, tabs);
  const order = before !== undefined ? insertBefore(shown.order, tabId, before) : insertAfter(shown.order, tabId, last);
  return { ...shown, order: sameIds(shown.order, order) };
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
const COLLAPSE_TRANSITIONS: Record<SplitPreset, Partial<Record<PaneId, { preset: SplitPreset; remap: PaneRemap }>>> = {
  single: {},
  cols2: { a: { preset: "single", remap: { b: "a" } }, b: { preset: "single", remap: {} } },
  "split-right": {
    a: { preset: "cols2", remap: { b: "a", c: "b" } },
    b: { preset: "cols2", remap: { c: "b" } },
    c: { preset: "cols2", remap: {} },
  },
  grid2x2: {
    a: { preset: "split-right", remap: { c: "a", d: "c" } },
    c: { preset: "split-right", remap: { d: "c" } },
  },
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
    const transition = COLLAPSE_TRANSITIONS[next.preset][last];
    if (occupiedPanes(next, tabs).includes(last) || !transition) {
      return next;
    }
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
export function collapseClosed(layout: ProjectLayout, tabs: LayoutTab[], previousTabs: LayoutTab[], listing: boolean): ProjectLayout {
  const occupied = occupiedPanes(layout, tabs);
  const emptied = occupiedPanes(layout, previousTabs).filter((paneId) => !occupied.includes(paneId));
  return collapsePanes(normalizeLayout(layout, tabs, previousTabs, listing), emptied, tabs);
}

/**
 * The collapse once a project's bootstrap has listed every session: every empty pane counts as
 * emptied, a snap's included. What the transitions cannot take (the grid's b or d) stays. First a
 * restored active tab that never came gives way to the pane's most recently used one.
 */
export function collapseEmpty(layout: ProjectLayout, tabs: LayoutTab[]): ProjectLayout {
  const open = new Set(tabs.map((tab) => tab.tabId));
  const activeTab = sameRecord(
    layout.activeTab,
    Object.fromEntries(Object.entries(layout.activeTab).filter(([, tabId]) => tabId == null || open.has(tabId))),
  );
  const settled = activeTab === layout.activeTab ? layout : normalizeLayout({ ...layout, activeTab }, tabs, tabs, false);
  const occupied = occupiedPanes(settled, tabs);
  return collapsePanes(
    settled,
    PRESET_PANES[settled.preset].filter((paneId) => !occupied.includes(paneId)),
    tabs,
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

/** A box as fractions of `.panes-grid` — the unit of the snap zones and the snap preview. */
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
 * all of b.
 */
export type SnapZone = "right" | "top-right" | "bottom-right" | "bottom-left";
const SNAP_ZONES: Record<SnapZone, FractionBox> = {
  "top-right": { left: 3 / 4, top: 0, width: 1 / 4, height: 1 / 3 },
  right: { left: 3 / 4, top: 1 / 3, width: 1 / 4, height: 1 / 3 },
  "bottom-right": { left: 3 / 4, top: 2 / 3, width: 1 / 4, height: 1 / 3 },
  "bottom-left": { left: 0, top: 1 / 2, width: 1 / 4, height: 1 / 2 },
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
    "bottom-left": { preset: "grid2x2", target: "c", remap: {} },
  },
  cols2: {
    right: { preset: "cols2", target: "b", remap: {} },
    "top-right": { preset: "split-right", target: "b", remap: { b: "c" } },
    "bottom-right": { preset: "split-right", target: "c", remap: {} },
    "bottom-left": { preset: "grid2x2", target: "c", remap: {} },
  },
  "split-right": {
    "top-right": { preset: "split-right", target: "b", remap: {} },
    "bottom-right": { preset: "split-right", target: "c", remap: {} },
    "bottom-left": { preset: "grid2x2", target: "c", remap: { c: "d" } },
  },
  grid2x2: {
    "top-right": { preset: "grid2x2", target: "b", remap: {} },
    "bottom-right": { preset: "grid2x2", target: "d", remap: {} },
    "bottom-left": { preset: "grid2x2", target: "c", remap: {} },
  },
};

/**
 * The three sashes as shares of `.panes-grid`. Per *sash*, not per preset, so a preset
 * switch moves none.
 */
interface SashShares {
  col: number;
  rowLeft: number;
  rowRight: number;
}

/** Each pane's box given the sashes — the snap preview of the pane a drop would add. */
const PANE_BOXES: Record<SplitPreset, Partial<Record<PaneId, (shares: SashShares) => FractionBox>>> = {
  single: { a: () => ({ left: 0, top: 0, width: 1, height: 1 }) },
  cols2: {
    a: ({ col }) => ({ left: 0, top: 0, width: col, height: 1 }),
    b: ({ col }) => ({ left: col, top: 0, width: 1 - col, height: 1 }),
  },
  "split-right": {
    a: ({ col }) => ({ left: 0, top: 0, width: col, height: 1 }),
    b: ({ col, rowRight }) => ({ left: col, top: 0, width: 1 - col, height: rowRight }),
    c: ({ col, rowRight }) => ({ left: col, top: rowRight, width: 1 - col, height: 1 - rowRight }),
  },
  grid2x2: {
    a: ({ col, rowLeft }) => ({ left: 0, top: 0, width: col, height: rowLeft }),
    b: ({ col, rowRight }) => ({ left: col, top: 0, width: 1 - col, height: rowRight }),
    c: ({ col, rowLeft }) => ({ left: 0, top: rowLeft, width: col, height: 1 - rowLeft }),
    d: ({ col, rowRight }) => ({ left: col, top: rowRight, width: 1 - col, height: 1 - rowRight }),
  },
};

export function paneBox(preset: SplitPreset, paneId: PaneId, shares: SashShares): FractionBox | null {
  return PANE_BOXES[preset][paneId]?.(shares) ?? null;
}

/**
 * A tab dropped on a snap zone: preset switch and move in one state write, so the tab never renders
 * in the focused pane between. No collapse, unlike `activateTab`: the user asked for this layout.
 */
export function snapTab(layout: ProjectLayout, tabId: string, transition: SnapTransition, tabs: LayoutTab[]): ProjectLayout {
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
  grid2x2: { a: "top-left", b: "top-right", c: "bottom-left", d: "bottom-right" },
};

function paneAt(preset: SplitPreset, position: PanePosition | undefined): PaneId | undefined {
  return PRESET_PANES[preset].find((paneId) => PANE_POSITIONS[preset][paneId] === position);
}

/**
 * A saved command's new tab goes beside an open tab of the same command, else to the recorded
 * place — the same position in the current preset, or the recorded preset restored like a snap.
 * Placed, so nothing collapses. A command never run goes to the focused pane.
 */
export function placeCommandTab(layout: ProjectLayout, tabId: string, command: string, tabs: LayoutTab[]): ProjectLayout {
  const open = tabs.find((tab) => tab.command === command && tab.tabId !== tabId);
  const place = open ? { preset: layout.preset, pane: paneOf(layout, open.tabId) } : ownValue(layout.commandPane, command);
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
 * How far past its zone the pointer may stray; stops the snap preview flickering between two zones.
 */
const SNAP_STICKY = 0.03;

/**
 * The snap zone under `point` (grid fractions), `active` keeping its margin — only zones the
 * preset has an entry for. Not asked over a tab strip.
 */
export function snapZoneAt(
  preset: SplitPreset,
  point: { x: number; y: number },
  active: SnapZone | null,
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
 * `localStorage` under `layout-storage.ts`'s namespace: layout describes the window, not the
 * repository. Per repository or worktree (its `refKey`), unlike `useStoredSize`/`useStoredToggle`'s fixed
 * keys. `suffix` tells the layout from `TabArea`'s sash positions.
 */
export function layoutStorageKey(refKey: string, suffix: string): string {
  return layoutKey(`terminals.${refKey}.${suffix}`);
}

/**
 * What survives a restart, the one record of a repository or worktree, as VS Code keeps its
 * editors': preset, focused pane, and every tab that comes back (`PersistedTab`) in the strip's
 * order. An agent's tab is keyed by its *session id* — a new one returns, if at all, under it — an
 * editor tab and a plain shell by their own ids, which they keep (`use-tab-restore.ts`); what cannot
 * return (a saved command, an agent's tab with no session yet) is left out. A shell's output is kept
 * beside it (`use-tab-restore.ts`), as are the sash shares (`useSashFraction`).
 */
interface PersistedLayout {
  preset: SplitPreset;
  focusedPane: PaneId;
  tabs: PersistedTab[];
  /**
   * Each pane's active tab, by the same ids. Its pane waits for it while the sessions are listed; a
   * stale one (session deleted between runs) gives way once they are (`collapseEmpty`).
   */
  activeTab: Partial<Record<PaneId, string>>;
  /** The tabs last made active, by the same ids. */
  recent: string[];
  /** Where each saved command last lay — the closed ones as recorded, the open ones as they are. */
  commandPane: Record<string, CommandPlace>;
}

/** A tab that comes back, by what brings it back: its agent's session, or the window. */
export interface PersistedTab {
  id: string;
  pane: PaneId;
  kind: "session" | "editor" | "shell";
  /** An editor tab's file and editor (`editorEntry`). */
  editor?: EditorEntry;
}

/** A stored editor entry, read defensively: none where its file is not named. */
function readEditorEntry(value: unknown): EditorEntry | undefined {
  const { path, commit, preview, diff, markdownPreview, viewState } = (value ?? {}) as Record<string, unknown>;
  if (typeof path !== "string") {
    return undefined;
  }
  const { sha, parent, origPath } = (commit ?? {}) as Record<string, unknown>;
  return {
    path,
    commit:
      typeof sha === "string"
        ? { sha, parent: typeof parent === "string" ? parent : undefined, origPath: typeof origPath === "string" ? origPath : undefined }
        : undefined,
    preview: preview === true,
    diff: diff === true,
    markdownPreview: MARKDOWN_PREVIEW_MODES.find((mode) => mode === markdownPreview) ?? "off",
    viewState: viewState !== null && typeof viewState === "object" ? viewState : undefined,
  };
}

/**
 * The stored record, read defensively: a bad shape — or one without `tabs` — is no record. Gives the
 * layout (`loadLayout`) and the tabs to bring back (`use-tab-restore.ts`); an entry of the wrong
 * shape is dropped, one of a vanished session stays (`normalizeLayout`). Session ids come back as tab
 * ids, hence the editor tab's unlike id.
 */
export function loadPersisted(refKey: string): { layout: ProjectLayout; tabs: PersistedTab[] } {
  const fallback = { layout: defaultLayout(), tabs: [] };
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(layoutStorageKey(refKey, "layout")) ?? "null");
    if (typeof parsed !== "object" || parsed === null) {
      return fallback;
    }
    const { preset, focusedPane, tabs, activeTab, recent, commandPane } = parsed as Record<string, unknown>;
    if (!isSplitPreset(preset) || !isPaneId(focusedPane) || !Array.isArray(tabs)) {
      return fallback;
    }
    const kept = tabs.flatMap((entry: unknown): PersistedTab[] => {
      const { id, pane, kind, editor } = (entry ?? {}) as Record<string, unknown>;
      if (typeof id !== "string" || !isPaneId(pane)) {
        return [];
      }
      if (kind === "editor") {
        const read = readEditorEntry(editor);
        return read ? [{ id, pane, kind, editor: read }] : [];
      }
      return kind === "session" || kind === "shell" ? [{ id, pane, kind }] : [];
    });
    const active: Partial<Record<PaneId, string>> = {};
    if (activeTab !== null && typeof activeTab === "object") {
      for (const [paneId, tabId] of Object.entries(activeTab)) {
        if (isPaneId(paneId) && PRESET_PANES[preset].includes(paneId) && typeof tabId === "string") {
          active[paneId] = tabId;
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
    const layout: ProjectLayout = {
      preset,
      // Read before any tab list normalizes it (`paneOf`).
      focusedPane: PRESET_PANES[preset].includes(focusedPane) ? focusedPane : PRESET_PANES[preset][0],
      tabPane: Object.fromEntries(kept.map((tab) => [tab.id, tab.pane])),
      activeTab: active,
      order: kept.map((tab) => tab.id),
      recent: Array.isArray(recent) ? recent.filter((tabId): tabId is string => typeof tabId === "string") : NO_IDS,
      commandPane: places,
    };
    return { layout, tabs: kept };
  } catch {
    return fallback;
  }
}

export function loadLayout(refKey: string): ProjectLayout {
  return loadPersisted(refKey).layout;
}

/** How a tab comes back next run, under which id (`PersistedTab`); none for one that does not. */
function persistedOf(tab: LayoutTab, editorEntry: (tabId: string) => EditorEntry | undefined): Omit<PersistedTab, "pane"> | undefined {
  if (tab.sessionId !== undefined) {
    return { id: tab.sessionId, kind: "session" };
  }
  if (isEditorTabId(tab.tabId)) {
    const editor = editorEntry(tab.tabId);
    return editor && { id: tab.tabId, kind: "editor", editor };
  }
  return isPlainShell(tab) ? { id: tab.tabId, kind: "shell" } : undefined;
}

/**
 * Only tabs that come back are written, under their persisted id (`persistedOf`), so disk never
 * names an id the next run could hand to another tab. `editorEntry` reads an editor tab's file and
 * editor, which the layout does not hold.
 */
export function serializeLayout(layout: ProjectLayout, tabs: LayoutTab[], editorEntry: (tabId: string) => EditorEntry | undefined): string {
  // The open command tabs' panes over the recorded ones.
  const commandPane = { ...layout.commandPane };
  const activeTab: Partial<Record<PaneId, string>> = {};
  const persistedTabs: PersistedTab[] = [];
  const persistedIds = new Map<string, string>();
  for (const tab of inOrder(layout.order, tabs)) {
    const pane = layout.tabPane[tab.tabId];
    const persisted = pane !== undefined ? persistedOf(tab, editorEntry) : undefined;
    if (persisted !== undefined && pane !== undefined) {
      persistedTabs.push({ ...persisted, pane });
      persistedIds.set(tab.tabId, persisted.id);
      if (layout.activeTab[pane] === tab.tabId) {
        activeTab[pane] = persisted.id;
      }
    }
    if (tab.command !== undefined) {
      commandPane[tab.command] = { preset: layout.preset, pane: paneOf(layout, tab.tabId) };
    }
  }
  const persisted: PersistedLayout = {
    preset: layout.preset,
    focusedPane: layout.focusedPane,
    tabs: persistedTabs,
    activeTab,
    recent: layout.recent.flatMap((tabId) => persistedIds.get(tabId) ?? []),
    commandPane,
  };
  return JSON.stringify(persisted);
}

export function saveLayout(refKey: string, serialized: string): void {
  localStorage.setItem(layoutStorageKey(refKey, "layout"), serialized);
}

/** Drops everything stored under a repository's or worktree's refKey: removed, it never comes back
 *  under it. */
export function dropStoredLayout(refKey: string): void {
  const prefix = layoutStorageKey(refKey, "");
  const stored = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const entry of stored) {
    if (entry?.startsWith(prefix)) {
      localStorage.removeItem(entry);
    }
  }
}
