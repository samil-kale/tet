import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatest } from "../ui/use-latest";
import type { AgentInfo } from "../../shared/types/agents";
import type { ResolvedRef } from "../resolved-ref";
import { sameList } from "../identity";
import { disposeTerminal } from "./terminal-views";
import { PANE_IDS, layoutStorageKey, paneBox, snapZoneAt } from "./pane-layout";
import type { FractionBox, PaneId, ProjectLayout, SnapTransition, SnapZone } from "./pane-layout";
import { usePersistedShare } from "../ui/layout-storage";
import { useElementSize } from "../ui/use-element-size";
import { useFloatsOver } from "../ui/window-covered";
import { MIN_AREA_HEIGHT, MIN_AREA_WIDTH, Sash } from "../ui/Sash";
import { Pane, type DragPosition, type PaneChrome } from "./Pane";
import type { Lane } from "../../shared/types/settings";
import { isTerminalTab, type PaneTab } from "./pane-tab";
import { NO_TABS } from "./use-project-layouts";

/**
 * A sash's position as a *share* of its room (`usePersistedShare`): `pixelsFor` multiplies it
 * by `.panes-grid`'s live measurement, so an undragged sash is an even split at any size. A
 * drag, in `Sash`'s pixels, is turned back into a fraction (`sash` below). Persisted per
 * repository or worktree (`layoutStorageKey`).
 */
function useSashFraction(refKey: string, name: string, initial: number): [number, (fraction: number) => void] {
  return usePersistedShare(layoutStorageKey(refKey, `sash.${name}`), initial);
}

/** `pixels` within the same bounds `Sash` applies to a drag. */
function clampPixels(pixels: number, min: number, minOther: number, containerSize: number): number {
  return Math.min(Math.max(pixels, min), Math.max(min, containerSize - minOther));
}

/**
 * A sash's pixels: `fraction` of `containerSize`, clamped — a share set in a wider room can ask
 * for more than a narrower one has. `null` (not measured yet) gives `min`.
 */
function pixelsFor(fraction: number, min: number, minOther: number, containerSize: number | null): number {
  return containerSize === null ? min : clampPixels(Math.round(containerSize * fraction), min, minOther, containerSize);
}

/** Every sash's default share, and what "single" resets to. */
const HALF = 1 / 2;

/** The pane a dragged tab is over, and the snap zone under the pointer, if any. */
interface DragTarget {
  paneId: PaneId;
  zone: SnapZone | null;
  transition: SnapTransition | null;
}

/** A fraction box as the inline style of an absolutely positioned child of `.panes-grid`. */
function percentStyle(box: FractionBox): { left: string; top: string; width: string; height: string } {
  const percent = (fraction: number): string => `${fraction * 100}%`;
  return { left: percent(box.left), top: percent(box.top), width: percent(box.width), height: percent(box.height) };
}

interface TabAreaProps {
  resolved: ResolvedRef;
  /** This repository's or worktree's tabs, its editor tabs last. Held by App, since the project
   *  list needs all. */
  tabs: PaneTab[];
  visible: boolean;
  /** For the strip's toggles (`PaneChrome`). */
  freeLane: Lane | null;
  toggleOrder: readonly Lane[];
  onToggleLane: (lane: Lane) => void;
  onMoveToggle: (from: number, to: number) => void;
  agents: AgentInfo[];
  /** Bootstrap's session listing: strip-wide, with no tab to show on, so it falls to pane "a". */
  externalBusy: boolean;
  /** By `refKey`, as the layout callbacks below. */
  onCloseEditors: (refKey: string, tabIds: string[]) => void;
  layout: ProjectLayout;
  onActivateTab: (refKey: string, tabId: string, paneId?: PaneId) => void;
  onSnapTab: (refKey: string, tabId: string, transition: SnapTransition) => void;
  onFocusPane: (refKey: string, paneId: PaneId) => void;
  onOpenSettings: () => void;
  /** Tabs whose finished turn is not yet seen — App decides, this draws. */
  finishedTabIds: string[];
  /** Tabs stopped on an unanswered question — App decides, this draws. */
  waitingTabIds: string[];
  /** Tabs the progress bar is about, shown on each one's pane. */
  startingTabIds: string[];
}

/** One repository's or worktree's tab area: how many panes, how big, which tabs each holds. */
export const TabArea = memo(function TabArea({
  resolved,
  tabs,
  visible,
  freeLane,
  toggleOrder,
  onToggleLane,
  onMoveToggle,
  agents,
  externalBusy,
  onCloseEditors,
  layout,
  onActivateTab,
  onSnapTab,
  onFocusPane,
  onOpenSettings,
  finishedTabIds,
  waitingTabIds,
  startingTabIds,
}: TabAreaProps) {
  /**
   * Mirrored in a ref for the drop handler, which reads it synchronously without becoming a new
   * callback on each change. The source pane is a ref alone: set on `dragstart`, before any render.
   */
  const [dragTarget, setDragTargetState] = useState<DragTarget | null>(null);
  const dragTargetRef = useRef<DragTarget | null>(null);
  const dragSource = useRef<PaneId | null>(null);
  const knownTabs = useRef<PaneTab[]>([]);

  const onCloseEditorsHere = useCallback((tabIds: string[]) => onCloseEditors(resolved.refKey, tabIds), [onCloseEditors, resolved.refKey]);

  // Disposed only for a tab gone for good, not one moved to another pane.
  useEffect(() => {
    const previous = knownTabs.current;
    knownTabs.current = tabs;
    const ids = new Set(tabs.map((tab) => tab.tabId));
    for (const tab of previous) {
      // An editor tab's editor is disposed where it closes (use-editor-opening.ts's closeEditors), a
      // browser tab's page in main.
      if (!ids.has(tab.tabId) && isTerminalTab(tab)) {
        disposeTerminal(resolved.ref, tab.tabId);
      }
    }
  }, [tabs, resolved.ref]);

  // One share per sash, not per preset, so a preset switch moves no sash on screen.
  // Unconditional: hooks cannot follow the preset.
  const [colFraction, setColFraction] = useSashFraction(resolved.refKey, "col", HALF);
  const [leftRowFraction, setLeftRowFraction] = useSashFraction(resolved.refKey, "row-left", HALF);
  const [rightRowFraction, setRightRowFraction] = useSashFraction(resolved.refKey, "row-right", HALF);

  const gridRef = useRef<HTMLDivElement>(null);
  /** `.panes-grid`'s last measured size, what the sash fractions multiply. Re-seeded on coming
   *  on screen, or a restored split would draw at minimum widths. */
  const gridSize = useElementSize(gridRef, visible);

  // Every `Pane` prop stays stable, or its memo is off: focus, spinners and resizes re-render this.
  /** "single" resets every sash; a switch between two *split* presets does not. */
  const resetSashFractions = useCallback(() => {
    setColFraction(HALF);
    setLeftRowFraction(HALF);
    setRightRowFraction(HALF);
  }, [setColFraction, setLeftRowFraction, setRightRowFraction]);

  // On arriving at "single" — a pane collapsed away (`collapseEmptied`, through `use-project-layouts.ts`).
  const previousPreset = useRef(layout.preset);
  useEffect(() => {
    if (layout.preset === "single" && previousPreset.current !== "single") {
      resetSashFractions();
    }
    previousPreset.current = layout.preset;
  }, [layout.preset, resetSashFractions]);

  const chrome = useMemo<PaneChrome>(
    () => ({ freeLane, toggleOrder, onToggleLane, onMoveToggle, onOpenSettings }),
    [freeLane, toggleOrder, onToggleLane, onMoveToggle, onOpenSettings],
  );
  const onActivate = useCallback(
    (tabId: string, paneId: PaneId) => onActivateTab(resolved.refKey, tabId, paneId),
    [onActivateTab, resolved.refKey],
  );
  const onFocus = useCallback((paneId: PaneId) => onFocusPane(resolved.refKey, paneId), [onFocusPane, resolved.refKey]);

  const setDragTarget = useCallback((next: DragTarget | null) => {
    dragTargetRef.current = next;
    setDragTargetState(next);
  }, []);

  /** A ref so the drag callbacks stay stable. */
  const presetRef = useLatest(layout.preset);

  /** A tab is dragged: every browser tab's page in the panes gives way, or it would take the
   *  drag's events from the panes and their snap zones. */
  const [dragging, setDragging] = useState(false);
  useFloatsOver(gridRef, dragging);

  const onDragStart = useCallback((paneId: PaneId) => {
    dragSource.current = paneId;
    setDragging(true);
  }, []);

  /**
   * Every `dragover`; state changes only with the pane or zone. The pointer becomes grid fractions
   * here (`SNAP_ZONES`). Left (`position` null) clears only its own pane: a stale "left" after
   * crossing into the neighbour must not blank that out.
   */
  const onDragOverChange = useCallback(
    (paneId: PaneId, position: DragPosition | null) => {
      const current = dragTargetRef.current;
      if (position === null) {
        if (current?.paneId === paneId) {
          setDragTarget(null);
        }
        return;
      }
      const grid = gridRef.current?.getBoundingClientRect();
      // Over a tab strip, a plain move whatever zone lies under it: in cols2 the zones cover all of
      // b, leaving the strip to drop into b.
      const hit =
        position.overStrip || !grid || grid.width === 0 || grid.height === 0
          ? null
          : snapZoneAt(
              presetRef.current,
              { x: (position.x - grid.left) / grid.width, y: (position.y - grid.top) / grid.height },
              current?.paneId === paneId ? current.zone : null,
            );
      const zone = hit?.zone ?? null;
      if (current?.paneId === paneId && current.zone === zone) {
        return;
      }
      setDragTarget({ paneId, zone, transition: hit?.transition ?? null });
    },
    [presetRef, setDragTarget],
  );

  // `dragover` never sees the tab id, so the drop joins it with the zone.
  const onDropTab = useCallback(
    (paneId: PaneId, tabId: string) => {
      const target = dragTargetRef.current;
      setDragTarget(null);
      dragSource.current = null;
      setDragging(false);
      if (target?.transition) {
        onSnapTab(resolved.refKey, tabId, target.transition);
      } else {
        onActivate(tabId, paneId);
      }
    },
    [setDragTarget, onSnapTab, resolved.refKey, onActivate],
  );

  // Unconditional, unlike "left": nothing stale follows a drag's end, and a snap preview would survive
  // an Escape.
  const onDragEnd = useCallback(() => {
    setDragTarget(null);
    dragSource.current = null;
    setDragging(false);
  }, [setDragTarget]);

  // Each pane's tabs, identity kept when unchanged. Keyed on the fields `paneOf` reads, not the
  // layout: a selection change must not hand every pane a fresh list.
  const { tabPane, focusedPane } = layout;
  const paneTabsRef = useRef<Partial<Record<PaneId, PaneTab[]>>>({});
  const paneTabs = useMemo(() => {
    const next: Partial<Record<PaneId, PaneTab[]>> = {};
    for (const paneId of PANE_IDS) {
      next[paneId] = sameList(
        paneTabsRef.current[paneId],
        tabs.filter((tab) => (tabPane[tab.tabId] ?? focusedPane) === paneId),
        NO_TABS,
      );
    }
    paneTabsRef.current = next;
    return next;
  }, [tabs, tabPane, focusedPane]);

  // Whether a pane's *own* tab is starting, apart from `first`/`chrome`.
  const startingHere = useMemo(() => {
    const ids = new Set(startingTabIds);
    const next: Partial<Record<PaneId, boolean>> = {};
    for (const paneId of PANE_IDS) {
      next[paneId] = (paneTabs[paneId] ?? NO_TABS).some((tab) => ids.has(tab.tabId));
    }
    return next;
  }, [paneTabs, startingTabIds]);

  // Where the drop would land: the pane under the pointer, or a zone's pane the preset already
  // has. Not the source pane, nor while a zone would switch the preset.
  const framedPane =
    dragTarget === null
      ? null
      : dragTarget.transition === null
        ? dragTarget.paneId
        : dragTarget.transition.preset === layout.preset
          ? dragTarget.transition.target
          : null;
  const dragOverPane = framedPane !== null && framedPane !== dragSource.current ? framedPane : null;

  const renderPane = (paneId: PaneId, size: { width?: number; height?: number }, first: boolean) => (
    <Pane
      key={paneId}
      at={resolved.ref}
      paneId={paneId}
      preset={layout.preset}
      tabs={paneTabs[paneId] ?? NO_TABS}
      activeTabId={layout.activeTab[paneId] ?? null}
      agents={agents}
      visible={visible}
      focused={layout.focusedPane === paneId}
      width={size.width}
      height={size.height}
      onActivate={onActivate}
      onFocus={onFocus}
      onCloseEditors={onCloseEditorsHere}
      finishedTabIds={finishedTabIds}
      waitingTabIds={waitingTabIds}
      chrome={first ? chrome : undefined}
      // Pane "a" also carries the strip-wide reason.
      busy={(first && externalBusy) || (startingHere[paneId] ?? false)}
      dragOver={dragOverPane === paneId}
      onDragStart={onDragStart}
      onDragOverChange={onDragOverChange}
      onDropTab={onDropTab}
      onDragEnd={onDragEnd}
    />
  );

  const sash = (
    orientation: "vertical" | "horizontal",
    pixels: number,
    min: number,
    minOther: number,
    containerSize: number | null,
    commit: (fraction: number) => void,
  ) => (
    <Sash
      orientation={orientation}
      size={pixels}
      min={min}
      // Sash clamps against the whole grid, `containerSize` may be only part of it: the rest is
      // "other" too, or dragging back from that edge first works off an overshoot.
      minOther={minOther + ((orientation === "vertical" ? gridSize?.width : gridSize?.height) ?? 0) - (containerSize ?? 0)}
      // Back to a fraction of the room and bounds `pixelsFor` used, so no share is stored that
      // the room cannot show.
      onResize={(next) => {
        if (containerSize !== null && containerSize > 0) {
          commit(clampPixels(next, min, minOther, containerSize) / containerSize);
        }
      }}
    />
  );

  // All three sashes whatever the preset: the snap preview needs the ones a switch would keep.
  const width = gridSize?.width ?? null;
  const height = gridSize?.height ?? null;
  const colPixels = pixelsFor(colFraction, MIN_AREA_WIDTH, MIN_AREA_WIDTH, width);
  const leftRowPixels = pixelsFor(leftRowFraction, MIN_AREA_HEIGHT, MIN_AREA_HEIGHT, height);
  const rightRowPixels = pixelsFor(rightRowFraction, MIN_AREA_HEIGHT, MIN_AREA_HEIGHT, height);

  // The pane a preset-switching zone drop would add, from the clamped pixels, not the stored
  // fractions, so the snap preview agrees with the drop.
  const snapPreview =
    dragTarget?.transition && dragTarget.transition.preset !== layout.preset && gridSize !== null
      ? paneBox(dragTarget.transition.preset, dragTarget.transition.target, {
          col: colPixels / gridSize.width,
          rowLeft: leftRowPixels / gridSize.height,
          rowRight: rightRowPixels / gridSize.height,
        })
      : null;

  // The three sashes, once: a preset draws the ones it has.
  const colSash = sash("vertical", colPixels, MIN_AREA_WIDTH, MIN_AREA_WIDTH, width, setColFraction);
  const leftRowSash = sash("horizontal", leftRowPixels, MIN_AREA_HEIGHT, MIN_AREA_HEIGHT, height, setLeftRowFraction);
  const rightRowSash = sash("horizontal", rightRowPixels, MIN_AREA_HEIGHT, MIN_AREA_HEIGHT, height, setRightRowFraction);

  const renderGrid = () => {
    switch (layout.preset) {
      case "single":
        return renderPane("a", {}, true);
      case "cols2":
        return (
          <>
            {renderPane("a", { width: colPixels }, true)}
            {colSash}
            {renderPane("b", {}, false)}
          </>
        );
      case "split-right":
        return (
          <>
            {renderPane("a", { width: colPixels }, true)}
            {colSash}
            <div className="panes-column fill">
              {renderPane("b", { height: rightRowPixels }, false)}
              {rightRowSash}
              {renderPane("c", {}, false)}
            </div>
          </>
        );
      case "grid2x2":
        return (
          <>
            <div className="panes-column" style={{ width: colPixels }}>
              {renderPane("a", { height: leftRowPixels }, true)}
              {leftRowSash}
              {renderPane("c", {}, false)}
            </div>
            {colSash}
            <div className="panes-column fill">
              {renderPane("b", { height: rightRowPixels }, false)}
              {rightRowSash}
              {renderPane("d", {}, false)}
            </div>
          </>
        );
    }
  };

  return (
    <div className={`tab-area${visible ? "" : " pane-hidden"}`}>
      <div className="panes-grid" ref={gridRef}>
        {renderGrid()}
        {/* An overlay only: panes resize on the drop, since a resize refits every pty
            (`fitTerminal`). */}
        {snapPreview && <div className="snap-preview" style={percentStyle(snapPreview)} />}
      </div>
    </div>
  );
});
