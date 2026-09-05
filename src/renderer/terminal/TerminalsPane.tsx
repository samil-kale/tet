import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project, TerminalDescriptor } from "../../shared/types";
import { sameList } from "../identity";
import { disposeTerminal, setRevealHandler } from "./terminal-views";
import { PANE_IDS, layoutStorageKey, paneBox, snapZoneAt } from "./pane-layout";
import type { FractionBox, PaneId, ProjectLayout, SnapTransition, SnapZone, SplitPreset } from "./pane-layout";
import { MIN_PANE_HEIGHT, MIN_PANE_WIDTH, Sash, usePersistedNumber } from "../ui/Sash";
import { Pane, type DragPosition, type PaneChrome } from "./Pane";
import { useAgents } from "../ui/use-agents";

/**
 * A divider's position as a *share* of the room it divides, not a pixel count — `usePaneSize`'s
 * unit, which is right for a sidebar, is wrong here. A size stored in pixels is only ever
 * correct for the container it was dragged against; a split has to stay proportional when the
 * window, the sidebar or the git pane change the room it has, and keeping a pixel size in step
 * with that meant rescaling every stored value on every resize — bookkeeping that could drift
 * from an even split for reasons it never saw. A fraction needs none of it: `renderGrid`
 * multiplies it by `.panes-grid`'s own current measurement on every render, so a divider nobody
 * has dragged is an exact even split at any size (the default alone does that — nothing has to
 * know whether it was ever touched), and a dragged one stays exactly the share it was set to. A
 * drag reports itself in pixels, the only unit `Sash` deals in, and is turned back into a
 * fraction of the room it was dragged against before it gets here — see `divider` below.
 *
 * Restored on the next start, under the project like the layout itself (`layoutStorageKey`).
 * Anything but a fraction strictly between 0 and 1 is ignored on both ends: read back, since
 * the value is a file the user can edit, and written, since a room too small for two minimum
 * panes has no valid share to store.
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

/**
 * The pixel size a divider is rendered at: `fraction` of `containerSize`, floored at `min` and
 * capped so the pane on the other side keeps `minOther` — the same bounds `Sash` applies to a
 * drag, applied here to a stored share too, since a share stored against a wider room can ask
 * for more than a narrower one has. `null` while the grid has not been measured yet gives
 * `min`, corrected the moment `gridSize` arrives — see the `useLayoutEffect` below for why that
 * is before the first paint, not one after it.
 */
function clampPixels(pixels: number, min: number, minOther: number, containerSize: number): number {
  return Math.min(Math.max(pixels, min), Math.max(min, containerSize - minOther));
}

function pixelsFor(fraction: number, min: number, minOther: number, containerSize: number | null): number {
  return containerSize === null ? min : clampPixels(Math.round(containerSize * fraction), min, minOther, containerSize);
}

/** Every divider's own default share — what an even split is, and what "single" resets back to. */
const HALF = 1 / 2;

/** The tabs of a pane that has none — one shared instance, so an empty pane's prop is stable. */
const NO_PANE_TABS: TerminalDescriptor[] = [];

/** The pane a dragged tab is over, and the snap zone the pointer is in, if any — see `dragTarget`. */
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
  /** This project's tabs. Held by App, since the project list needs every project's. */
  tabs: TerminalDescriptor[];
  visible: boolean;
  /** Whether the git pane beside this one is open; the button in the strip shows which. */
  gitOpen: boolean;
  onToggleGit: () => void;
  /** Whether this project's repository has local changes; the button in the strip colors on it. */
  gitDirty: boolean;
  /** Bootstrap's own session listing, before any tab exists yet to carry `starting` itself — the
      one project-wide reason left with no tab of its own to show on, so it falls to pane "a". */
  externalBusy: boolean;
  /** A file ctrl-clicked in a terminal opens over everything as a diff; "Browse files" (below)
   *  opens the same dialog with nothing chosen yet, hence the path being optional here. */
  onOpenDiff: (projectId: string, path?: string) => void;
  /** This project's split state — preset, focus, and which pane every tab and its selection live in. */
  layout: ProjectLayout;
  onActivateTab: (projectId: string, tabId: string, paneId?: PaneId) => void;
  /** A tab dropped on one of the snap zones below — the preset switch and the move in one. */
  onSnapTab: (projectId: string, tabId: string, transition: SnapTransition) => void;
  onFocusPane: (projectId: string, paneId: PaneId) => void;
  onPresetChange: (projectId: string, preset: SplitPreset) => void;
  /** The settings dialog — opened from the pane the layout picker sits on, beside it. */
  onOpenSettings: () => void;
  /** Tabs whose finished turn is still waiting to be looked at — App decides, this draws it. */
  markedTabIds: string[];
  /** Tabs stopped mid-turn on an unanswered question — decided in App for the same reason. */
  waitingTabIds: string[];
  /** Tabs the progress bar is currently about — shown on whichever pane each one lives in. */
  startingTabIds: string[];
}

/**
 * One project's terminals: its panes, laid out by its preset, with a `Sash` between each pair.
 * The panes themselves are `Pane`; this is what decides how many there are, how big, and which
 * tabs each one holds — see "Split view" in CLAUDE.md.
 */
export const TerminalsPane = memo(function TerminalsPane({
  project,
  tabs,
  visible,
  gitOpen,
  onToggleGit,
  gitDirty,
  externalBusy,
  onOpenDiff,
  layout,
  onActivateTab,
  onSnapTab,
  onFocusPane,
  onPresetChange,
  onOpenSettings,
  markedTabIds,
  waitingTabIds,
  startingTabIds
}: TerminalsPaneProps) {
  const agents = useAgents();
  /**
   * Where a dragged tab is right now: the pane under it, and — when the pointer is in one of
   * the snap zones — what the drop would do there (the preview box for a preset switch is
   * derived at render, from the same sizes the panes get — see `snapPreview` below). Mirrored
   * in a ref for the drop handler, which needs the answer synchronously
   * without becoming a new callback on every change. What the tab came from is a ref alone: it
   * is set on `dragstart`, before any render this state causes.
   */
  const [dragTarget, setDragTargetState] = useState<DragTarget | null>(null);
  const dragTargetRef = useRef<DragTarget | null>(null);
  const dragSource = useRef<PaneId | null>(null);
  const knownTabs = useRef<TerminalDescriptor[]>([]);

  // Ctrl+clicking a changed file in a terminal opens that file's diff over everything.
  useEffect(() => setRevealHandler(project.id, (path) => onOpenDiff(project.id, path)), [project.id, onOpenDiff]);

  /** "Browse files": the same dialog, opened with nothing chosen yet. */
  const browseFiles = useCallback(() => onOpenDiff(project.id), [project.id, onOpenDiff]);

  // The xterm instances live outside React, keyed by tab id — a tab gone for good (not just
  // moved to another pane) is where they are let go of.
  useEffect(() => {
    const previous = knownTabs.current;
    knownTabs.current = tabs;
    const ids = new Set(tabs.map((tab) => tab.tabId));
    for (const tab of previous) {
      if (!ids.has(tab.tabId)) {
        disposeTerminal(project.id, tab.tabId);
      }
    }
  }, [tabs, project.id]);

  // One share per divider *line*, not per preset: the column line is the same line whether it
  // has one pane or two on its right, and the right column's row line is where it is whether
  // the left column is split or not. Every split preset that has a line reads the same stored
  // share, so switching presets adds or removes a sash and moves nothing already on screen —
  // one share each was what made a pane jump on every switch. Declared unconditionally, since
  // hooks cannot follow which preset happens to be active; only the ones the current preset
  // actually renders a Sash for ever change or get read.
  const [colFraction, setColFraction] = useDividerFraction(project.id, "col", HALF);
  const [leftRowFraction, setLeftRowFraction] = useDividerFraction(project.id, "row-left", HALF);
  const [rightRowFraction, setRightRowFraction] = useDividerFraction(project.id, "row-right", HALF);

  const gridRef = useRef<HTMLDivElement>(null);
  /**
   * `.panes-grid`'s own last measured size — what every divider's fraction is multiplied by in
   * `renderGrid`. Nothing here ever writes a divider's own stored value: a fraction already
   * means the same thing at any size, so keeping it in step with a resize is `renderGrid` simply
   * running again with a new `gridSize`, not something this effect has to do.
   *
   * `useLayoutEffect`, not `useEffect`, and seeded with a synchronous `getBoundingClientRect()`
   * rather than waiting on the observer's own first callback: that callback is inherently
   * asynchronous (part of the spec, not an implementation detail to work around), so a plain
   * effect would let the browser paint once with `gridSize` still null before correcting itself.
   * Measuring synchronously here means React has the real number *before* that first paint, so a
   * project whose persisted preset is already "cols2" the moment it opens shows an even split
   * immediately rather than flashing the wrong one first.
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
    // Re-seeded when the project comes on screen: hidden (`display: none`) it measured zero,
    // and the observer's callback comes after the paint that a restored split would otherwise
    // draw one frame at minimum widths.
  }, [visible]);

  // Everything a `Pane` takes is kept stable across renders that do not change it, or its memo
  // would be switched off — a focus change, a spinner starting in another pane, a resize of the
  // grid all re-render this component, and none of them should re-render a pane they leave alone.
  /**
   * Switching to "single" also puts every divider back at its default share — "single" is the
   * one preset that never renders a `Sash` at all, so it is the natural "start over" point: a
   * user who wants a clean 50/50 next time they split closes the split first, rather than this
   * needing a reset action of its own. Switching between two *split* presets leaves every
   * divider alone — the lines they share stay where they are.
   */
  const resetDividerFractions = useCallback(() => {
    setColFraction(HALF);
    setLeftRowFraction(HALF);
    setRightRowFraction(HALF);
  }, [setColFraction, setLeftRowFraction, setRightRowFraction]);

  // On the preset actually arriving at "single", wherever the switch came from: the picker, or a
  // pane emptied and collapsed away (`collapseEmptied`, decided in `App`). An effect rather
  // than a call beside the picker, so both take the same path; after the render is soon enough,
  // since "single" draws no sash that could show the old share.
  const previousPreset = useRef(layout.preset);
  useEffect(() => {
    if (layout.preset === "single" && previousPreset.current !== "single") {
      resetDividerFractions();
    }
    previousPreset.current = layout.preset;
  }, [layout.preset, resetDividerFractions]);

  const onPresetChangeHere = useCallback(
    (preset: SplitPreset) => onPresetChange(project.id, preset),
    [onPresetChange, project.id]
  );
  const chrome = useMemo<PaneChrome>(
    () => ({ gitOpen, onToggleGit, gitDirty }),
    [gitOpen, onToggleGit, gitDirty]
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

  /** `preset` as the drop would find it — read through a ref so the drag callbacks stay stable. */
  const presetRef = useRef(layout.preset);
  presetRef.current = layout.preset;

  const onDragStart = useCallback((paneId: PaneId) => {
    dragSource.current = paneId;
  }, []);

  /**
   * Called for every `dragover` a pane sees, which is constantly; the state only changes when
   * the pane or the zone does, so a pointer moving within one zone renders nothing. The zones
   * are a map of the whole grid (`SNAP_ZONES`), so the pointer is turned into fractions of it
   * here — the one place with the grid's own box. Left (`position` null) clears whatever pane it
   * names, and only that one: a stale "left" arriving after the pointer has already crossed into
   * its neighbour must not blank the new one out.
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
      // Over a tab strip the drop is a plain move into that pane, whatever zone lies under it —
      // in cols2 the zones cover all of b, and the strip is what is left to drop into b with.
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

  // The zone is read from state rather than the event: `dragover` never gets to see the tab id,
  // so the drop is the first moment both are known.
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

  // Unconditional, unlike "left" above: nothing stale can follow the end of a drag, and a
  // preview over a pane other than the one the tab came from would otherwise survive an Escape.
  const onDragEnd = useCallback(() => {
    setDragTarget(null);
    dragSource.current = null;
  }, [setDragTarget]);

  // Each pane's tabs, in the project's own order — by identity where the answer did not change,
  // for the same reason `App` does that for the mark lists it hands down. Keyed on the two
  // fields `paneOf` reads rather than the layout: the focused pane only matters for a tab not in
  // `tabPane` yet (the one render between its push arriving and `normalizeLayout` writing its
  // entry), and a selection change must not hand every pane a fresh list.
  const { tabPane, focusedPane } = layout;
  const paneTabsRef = useRef<Partial<Record<PaneId, TerminalDescriptor[]>>>({});
  const paneTabs = useMemo(() => {
    const next: Partial<Record<PaneId, TerminalDescriptor[]>> = {};
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

  // Whether one of a pane's *own* tabs is what the progress bar is about — a new agent opened
  // there, its runtime still being prepared. Independent of `first`/`chrome`: unlike the git
  // toggle, this is not bound to pane "a" once the reason is a tab starting somewhere else.
  const startingHere = useMemo(() => {
    const ids = new Set(startingTabIds);
    const next: Partial<Record<PaneId, boolean>> = {};
    for (const paneId of PANE_IDS) {
      next[paneId] = (paneTabs[paneId] ?? NO_PANE_TABS).some((tab) => ids.has(tab.tabId));
    }
    return next;
  }, [paneTabs, startingTabIds]);

  // The pane the drop would land in: the one under the pointer for a plain drop, the zone's
  // own pane for a zone the preset already has. Not the one the tab came from (a drop there
  // does nothing, and in a single pane the frame would be the whole window), and not while a
  // zone would switch the preset: then the preview says where the tab goes, not a pane.
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
      markedTabIds={markedTabIds}
      waitingTabIds={waitingTabIds}
      chrome={first ? chrome : undefined}
      // The picker sits beside the git toggle, on pane "a" — the same pane `chrome` is on.
      onPresetChange={first ? onPresetChangeHere : undefined}
      onBrowseFiles={first ? browseFiles : undefined}
      onOpenSettings={first ? onOpenSettings : undefined}
      // Pane "a" also carries whatever project-wide reason has no tab of its own to point at;
      // every other pane only ever shows its own.
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
      // Sash clamps against its own container, the whole grid, while `containerSize` may be only
      // the room left of it — the rest of the grid is "other" too, or dragging back from that
      // edge first works off an overshoot.
      minOther={minOther + ((orientation === "vertical" ? gridSize?.width : gridSize?.height) ?? 0) - (containerSize ?? 0)}
      // A drag reports itself in pixels — turned back into a fraction of the same room
      // `pixelsFor` measured it against, and through the same bounds, so the two never disagree
      // about what "half" means and a share never gets stored that the room cannot show.
      onResize={(next) => {
        if (containerSize !== null && containerSize > 0) {
          commit(clampPixels(next, min, minOther, containerSize) / containerSize);
        }
      }}
    />
  );

  // Where the three divider lines are, in pixels of the grid — computed once, whatever the
  // preset, since the preview below needs the line a preset switch would keep as much as
  // `renderGrid` needs the ones the current preset draws. The column line is the same for every
  // split preset, and both columns run the grid's full height, so each row line is a share of
  // that directly.
  const width = gridSize?.width ?? null;
  const height = gridSize?.height ?? null;
  const colPixels = pixelsFor(colFraction, MIN_PANE_WIDTH, MIN_PANE_WIDTH, width);
  const leftRowPixels = pixelsFor(leftRowFraction, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height);
  const rightRowPixels = pixelsFor(rightRowFraction, MIN_PANE_HEIGHT, MIN_PANE_HEIGHT, height);

  // The box of the pane a zone drop would add — the one it *will* have, since the drop keeps
  // every line where it is: the clamped pixels the panes are laid out at, back as shares of
  // the grid, not the stored fractions (a share stored against a wider room is clamped on the
  // way to the screen, and the preview has to agree with what the drop then shows). Only for a
  // zone that switches the preset; a zone whose pane the preset already has frames that pane
  // itself (`dragOverPane` above).
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
        {/* An overlay and nothing more: the panes keep their sizes until the drop, since any
            resize refits every pty under it, mid-drag — see `fitTerminal`. */}
        {snapPreview && <div className="snap-preview" style={percentStyle(snapPreview)} />}
      </div>
    </div>
  );
});
