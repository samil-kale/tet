import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../shared/types";
import { sameList } from "../identity";
import { disposeTerminal, setRevealHandler } from "./terminal-views";
import { PANE_IDS, layoutStorageKey, paneBox, snapZoneAt } from "./pane-layout";
import type { FractionBox, PaneId, ProjectLayout, SnapTransition, SnapZone } from "./pane-layout";
import { MIN_PANE_HEIGHT, MIN_PANE_WIDTH, Sash, usePersistedNumber } from "../ui/Sash";
import { Pane, type DragPosition, type PaneChrome, type SideView } from "./Pane";
import { isEditorTab, type PaneTab } from "./editor-tab";
import { useAgents } from "../ui/use-agents";

/**
 * A divider's position as a *share* of its room, not pixels: `renderGrid` multiplies it by
 * `.panes-grid`'s live measurement, so an undragged divider is an even split at any size. A drag,
 * in `Sash`'s pixels, is turned back into a fraction (`divider` below).
 *
 * Persisted per project (`layoutStorageKey`). Anything outside (0, 1) is ignored both ways: read,
 * since the user can edit it, and written, since a room too small for two panes has no share.
 */
function useDividerFraction(projectId: string, name: string, initial: number): [number, (fraction: number) => void] {
  const [fraction, setFraction] = usePersistedNumber(layoutStorageKey(projectId, `divider.${name}`), (stored) =>
    Number.isFinite(stored) && stored > 0 && stored < 1 ? stored : initial
  );
  const set = useCallback(
    (next: number) => {
      if (next > 0 && next < 1) {
        setFraction(next);
      }
    },
    [setFraction]
  );
  return [fraction, set];
}

/** `pixels` within the same bounds `Sash` applies to a drag. */
function clampPixels(pixels: number, min: number, minOther: number, containerSize: number): number {
  return Math.min(Math.max(pixels, min), Math.max(min, containerSize - minOther));
}

/**
 * A divider's pixels: `fraction` of `containerSize`, clamped — a share set in a wider room can ask
 * for more than a narrower one has. `null` (not measured yet) gives `min`.
 */
function pixelsFor(fraction: number, min: number, minOther: number, containerSize: number | null): number {
  return containerSize === null ? min : clampPixels(Math.round(containerSize * fraction), min, minOther, containerSize);
}

/** Every divider's default share, and what "single" resets to. */
const HALF = 1 / 2;

/** Shared, so an empty pane's prop is stable. */
const NO_PANE_TABS: PaneTab[] = [];

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

interface TerminalsPaneProps {
  project: Project;
  /** This project's tabs, its editor tabs last. Held by App, since the project list needs all. */
  tabs: PaneTab[];
  visible: boolean;
  /** What the side pane shows, if it is out. */
  sideView: SideView | null;
  onToggleGit: () => void;
  onToggleFiles: () => void;
  /** Bootstrap's session listing: project-wide, with no tab to show on, so it falls to pane "a". */
  externalBusy: boolean;
  /** Opens a path ctrl-clicked in a terminal in the project's preview tab. */
  onOpenDiff: (projectId: string, path: string) => void;
  onCloseEditors: (projectId: string, tabIds: string[]) => void;
  layout: ProjectLayout;
  onActivateTab: (projectId: string, tabId: string, paneId?: PaneId) => void;
  onSnapTab: (projectId: string, tabId: string, transition: SnapTransition) => void;
  onFocusPane: (projectId: string, paneId: PaneId) => void;
  onOpenSettings: () => void;
  /** Tabs whose finished turn is not yet seen — App decides, this draws. */
  markedTabIds: string[];
  /** Tabs stopped on an unanswered question — App decides, this draws. */
  waitingTabIds: string[];
  /** Tabs the progress bar is about, shown on each one's pane. */
  startingTabIds: string[];
}

/** One project's terminals: how many panes, how big, which tabs each holds. */
export const TerminalsPane = memo(function TerminalsPane({
  project,
  tabs,
  visible,
  sideView,
  onToggleGit,
  onToggleFiles,
  externalBusy,
  onOpenDiff,
  onCloseEditors,
  layout,
  onActivateTab,
  onSnapTab,
  onFocusPane,
  onOpenSettings,
  markedTabIds,
  waitingTabIds,
  startingTabIds
}: TerminalsPaneProps) {
  const agents = useAgents();
  /**
   * Mirrored in a ref for the drop handler, which reads it synchronously without becoming a new
   * callback on each change. The source pane is a ref alone: set on `dragstart`, before any render.
   */
  const [dragTarget, setDragTargetState] = useState<DragTarget | null>(null);
  const dragTargetRef = useRef<DragTarget | null>(null);
  const dragSource = useRef<PaneId | null>(null);
  const knownTabs = useRef<PaneTab[]>([]);

  useEffect(() => setRevealHandler(project.id, (path) => onOpenDiff(project.id, path)), [project.id, onOpenDiff]);

  const onCloseEditorsHere = useCallback((tabIds: string[]) => onCloseEditors(project.id, tabIds), [onCloseEditors, project.id]);

  // Disposed only for a tab gone for good, not one moved to another pane.
  useEffect(() => {
    const previous = knownTabs.current;
    knownTabs.current = tabs;
    const ids = new Set(tabs.map((tab) => tab.tabId));
    for (const tab of previous) {
      // An editor tab's editor is disposed where it closes (App).
      if (!ids.has(tab.tabId) && !isEditorTab(tab)) {
        disposeTerminal(project.id, tab.tabId);
      }
    }
  }, [tabs, project.id]);

  // One share per divider *line*, not per preset, so a preset switch moves no line on screen.
  // Unconditional: hooks cannot follow the preset.
  const [colFraction, setColFraction] = useDividerFraction(project.id, "col", HALF);
  const [leftRowFraction, setLeftRowFraction] = useDividerFraction(project.id, "row-left", HALF);
  const [rightRowFraction, setRightRowFraction] = useDividerFraction(project.id, "row-right", HALF);

  const gridRef = useRef<HTMLDivElement>(null);
  /**
   * `.panes-grid`'s last measured size, what the divider fractions multiply.
   *
   * A layout effect seeded with a synchronous `getBoundingClientRect()`, since the observer's first
   * callback is async: a restored split is right on the first paint, not flashed wrong first.
   */
  const [gridSize, setGridSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) {
      return;
    }
    const seed = element.getBoundingClientRect();
    if (seed.width > 0 && seed.height > 0) {
      setGridSize({ width: seed.width, height: seed.height });
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Zero while this project's tab is hidden (`display: none`) — not a real size.
      if (width > 0 && height > 0) {
        setGridSize({ width, height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
    // Re-seeded on coming on screen: hidden it measured zero, and the observer fires after the
    // paint, which would draw a restored split at minimum widths.
  }, [visible]);

  // Every `Pane` prop stays stable, or its memo is off: focus, spinners and resizes re-render this.
  /** "single" resets every divider; a switch between two *split* presets does not. */
  const resetDividerFractions = useCallback(() => {
    setColFraction(HALF);
    setLeftRowFraction(HALF);
    setRightRowFraction(HALF);
  }, [setColFraction, setLeftRowFraction, setRightRowFraction]);

  // On arriving at "single" — a pane collapsed away (`collapseEmptied`, in `App`).
  const previousPreset = useRef(layout.preset);
  useEffect(() => {
    if (layout.preset === "single" && previousPreset.current !== "single") {
      resetDividerFractions();
    }
    previousPreset.current = layout.preset;
  }, [layout.preset, resetDividerFractions]);

  const chrome = useMemo<PaneChrome>(
    () => ({
      sideView,
      onToggleGit,
      onToggleFiles,
      onOpenSettings
    }),
    [sideView, onToggleGit, onToggleFiles, onOpenSettings]
  );
  const onActivate = useCallback(
    (paneId: PaneId, tabId: string) => onActivateTab(project.id, tabId, paneId),
    [onActivateTab, project.id]
  );
  const onFocus = useCallback((paneId: PaneId) => onFocusPane(project.id, paneId), [onFocusPane, project.id]);

  const setDragTarget = useCallback((next: DragTarget | null) => {
    dragTargetRef.current = next;
    setDragTargetState(next);
  }, []);

  /** A ref so the drag callbacks stay stable. */
  const presetRef = useRef(layout.preset);
  presetRef.current = layout.preset;

  const onDragStart = useCallback((paneId: PaneId) => {
    dragSource.current = paneId;
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
              current?.paneId === paneId ? current.zone : null
            );
      const zone = hit?.zone ?? null;
      if (current?.paneId === paneId && current.zone === zone) {
        return;
      }
      setDragTarget({ paneId, zone, transition: hit?.transition ?? null });
    },
    [setDragTarget]
  );

  // `dragover` never sees the tab id, so the drop joins it with the zone.
  const onDropTab = useCallback(
    (paneId: PaneId, tabId: string) => {
      const target = dragTargetRef.current;
      setDragTarget(null);
      dragSource.current = null;
      if (target?.transition) {
        onSnapTab(project.id, tabId, target.transition);
      } else {
        onActivate(paneId, tabId);
      }
    },
    [setDragTarget, onSnapTab, project.id, onActivate]
  );

  // Unconditional, unlike "left": nothing stale follows a drag's end, and a preview would survive
  // an Escape.
  const onDragEnd = useCallback(() => {
    setDragTarget(null);
    dragSource.current = null;
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
        NO_PANE_TABS
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
      next[paneId] = (paneTabs[paneId] ?? NO_PANE_TABS).some((tab) => ids.has(tab.tabId));
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
      projectId={project.id}
      paneId={paneId}
      preset={layout.preset}
      tabs={paneTabs[paneId] ?? NO_PANE_TABS}
      activeTabId={layout.activeTab[paneId] ?? null}
      agents={agents}
      visible={visible}
      focused={layout.focusedPane === paneId}
      width={size.width}
      height={size.height}
      onActivate={onActivate}
      onFocus={onFocus}
      onCloseEditors={onCloseEditorsHere}
      markedTabIds={markedTabIds}
      waitingTabIds={waitingTabIds}
      chrome={first ? chrome : undefined}
      // Pane "a" also carries the project-wide reason.
      showProgress={(first && externalBusy) || (startingHere[paneId] ?? false)}
      dragOver={dragOverPane === paneId}
      onDragStart={onDragStart}
      onDragOverChange={onDragOverChange}
      onDropTab={onDropTab}
      onDragEnd={onDragEnd}
    />
  );

  const divider = (
    orientation: "vertical" | "horizontal",
    pixels: number,
    min: number,
    minOther: number,
    containerSize: number | null,
    commit: (fraction: number) => void
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

  // All three lines whatever the preset: the preview needs the lines a switch would keep.
  const width = gridSize?.width ?? null;
  const height = gridSize?.height ?? null;
  const colPixels = pixelsFor(colFraction, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width);
  const leftRowPixels = pixelsFor(leftRowFraction, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height);
  const rightRowPixels = pixelsFor(rightRowFraction, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height);

  // The pane a preset-switching zone drop would add, from the clamped pixels, not the stored
  // fractions, so the preview agrees with the drop.
  const snapPreview =
    dragTarget?.transition && dragTarget.transition.preset !== layout.preset && gridSize !== null
      ? paneBox(dragTarget.transition.preset, dragTarget.transition.target, {
          col: colPixels / gridSize.width,
          rowLeft: leftRowPixels / gridSize.height,
          rowRight: rightRowPixels / gridSize.height
        })
      : null;

  const renderGrid = () => {
    switch (layout.preset) {
      case "single":
        return renderPane("a", {}, true);
      case "cols2":
        return (
          <>
            {renderPane("a", { width: colPixels }, true)}
            {divider("vertical", colPixels, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width, setColFraction)}
            {renderPane("b", {}, false)}
          </>
        );
      case "split-right":
        return (
          <>
            {renderPane("a", { width: colPixels }, true)}
            {divider("vertical", colPixels, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width, setColFraction)}
            <div className="panes-column fill">
              {renderPane("b", { height: rightRowPixels }, false)}
              {divider("horizontal", rightRowPixels, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height, setRightRowFraction)}
              {renderPane("c", {}, false)}
            </div>
          </>
        );
      case "grid2x2":
        return (
          <>
            <div className="panes-column" style={{ width: colPixels }}>
              {renderPane("a", { height: leftRowPixels }, true)}
              {divider("horizontal", leftRowPixels, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height, setLeftRowFraction)}
              {renderPane("c", {}, false)}
            </div>
            {divider("vertical", colPixels, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width, setColFraction)}
            <div className="panes-column fill">
              {renderPane("b", { height: rightRowPixels }, false)}
              {divider("horizontal", rightRowPixels, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height, setRightRowFraction)}
              {renderPane("d", {}, false)}
            </div>
          </>
        );
    }
  };

  return (
    <div className={`pane-layout${visible ? "" : " pane-hidden"}`}>
      <div className="panes-grid" ref={gridRef}>
        {renderGrid()}
        {/* An overlay only: panes resize on the drop, since a resize refits every pty
            (`fitTerminal`). */}
        {snapPreview && <div className="snap-preview" style={percentStyle(snapPreview)} />}
      </div>
    </div>
  );
});
