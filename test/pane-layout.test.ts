import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SNAP_TRANSITIONS,
  activateTab,
  applyPreset,
  collapseClosed,
  collapseEmptied,
  collapseEmpty,
  defaultLayout,
  loadLayout,
  moveTab,
  normalizeLayout,
  serializeLayout,
  snapTab,
  snapZoneAt,
  visibleTabIds
} from "../src/renderer/terminal/pane-layout";
import type { ProjectLayout } from "../src/renderer/terminal/pane-layout";
import type { TerminalDescriptor } from "../src/shared/types";

/** The split view's rules — pure functions, the one part of the renderer that needs no window. */

function tab(tabId: string, updatedAt?: number, sessionId?: string): TerminalDescriptor {
  return { tabId, projectId: "p", agentId: "shell", title: "", status: "running", updatedAt, sessionId };
}

const NONE: TerminalDescriptor[] = [];

describe("normalizeLayout", () => {
  it("settles a new tab in the focused pane and opens on the most recently used one", () => {
    const layout: ProjectLayout = { ...defaultLayout(), preset: "cols2", focusedPane: "b" };
    const tabs = [tab("t1", 10), tab("t2", 30), tab("t3", 20)];
    const next = normalizeLayout(layout, tabs, NONE);
    assert.deepEqual(next.tabPane, { t1: "b", t2: "b", t3: "b" });
    assert.deepEqual(next.activeTab, { a: null, b: "t2" });
    assert.deepEqual(visibleTabIds(next), ["t2"]);
  });

  it("answers the same object when nothing changed", () => {
    const tabs = [tab("t1")];
    const once = normalizeLayout(defaultLayout(), tabs, NONE);
    assert.equal(normalizeLayout(once, tabs, tabs), once);
  });

  it("moves a pane's selection to the right neighbour, or left from the end", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3")];
    const layout = normalizeLayout({ ...defaultLayout(), activeTab: { a: "t2" } }, tabs, NONE);
    const withoutT2 = [tab("t1"), tab("t3")];
    assert.equal(normalizeLayout(layout, withoutT2, tabs).activeTab.a, "t3");
    const onT3 = { ...layout, activeTab: { a: "t3" } };
    assert.equal(normalizeLayout(onT3, [tab("t1"), tab("t2")], tabs).activeTab.a, "t2");
    assert.equal(normalizeLayout(onT3, NONE, tabs).activeTab.a, null);
  });

  it("leaves a selection alone that names a tab not pushed yet, and drops a closed tab's pane", () => {
    const tabs = [tab("t1")];
    const layout: ProjectLayout = { ...defaultLayout(), tabPane: { t1: "a", gone: "a" }, activeTab: { a: "new-9" } };
    const next = normalizeLayout(layout, tabs, [tab("t1"), tab("gone")]);
    assert.equal(next.activeTab.a, "new-9", "activated before its push arrived");
    assert.deepEqual(next.tabPane, { t1: "a" });
  });

  it("keeps a restored assignment for a tab whose listing has not come yet", () => {
    const layout: ProjectLayout = { ...defaultLayout(), preset: "cols2", tabPane: { later: "b", elsewhere: "c" } };
    const next = normalizeLayout(layout, NONE, NONE);
    assert.deepEqual(next.tabPane, { later: "b" }, "a pane the preset does not have is dropped");
    assert.equal(next.focusedPane, "a");
  });
});

describe("applyPreset", () => {
  it("hands the tabs of vanished panes to pane a and re-normalizes", () => {
    const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3)];
    const grid = normalizeLayout(
      { preset: "grid2x2", focusedPane: "d", tabPane: { t1: "a", t2: "c", t3: "d" }, activeTab: {} },
      tabs,
      NONE
    );
    const cols = applyPreset(grid, "cols2", tabs);
    assert.equal(cols.preset, "cols2");
    assert.equal(cols.focusedPane, "a");
    assert.deepEqual(cols.tabPane, { t1: "a", t2: "a", t3: "a" });
    assert.deepEqual(cols.activeTab, { a: "t1", b: null }, "pane a keeps what it was showing");
    assert.equal(applyPreset(cols, "cols2", tabs), cols, "the same preset is no change");
  });
});

describe("moveTab", () => {
  const tabs = [tab("t1"), tab("t2"), tab("t3"), tab("t4")];
  const cols2 = normalizeLayout(
    { preset: "cols2", focusedPane: "a", tabPane: { t1: "a", t2: "a", t3: "a", t4: "b" }, activeTab: { a: "t2" } },
    tabs,
    NONE
  );

  it("moves the tab, focuses the target, and leaves the source on the tab before", () => {
    const next = moveTab(cols2, "t2", "b", tabs);
    assert.equal(next.focusedPane, "b");
    assert.equal(next.tabPane.t2, "b");
    assert.deepEqual(next.activeTab, { a: "t1", b: "t2" });
    assert.equal(moveTab(cols2, "t1", "b", tabs).activeTab.a, "t2", "the first tab leaves the next one");
    assert.deepEqual(moveTab(cols2, "t4", "a", tabs).activeTab, { a: "t4", b: null }, "an emptied pane shows nothing");
  });

  it("is a plain activation within the same pane", () => {
    const next = moveTab(cols2, "t3", "a", tabs);
    assert.equal(next.tabPane, cols2.tabPane, "nothing reassigned");
    assert.deepEqual(next.activeTab, { a: "t3", b: "t4" });
  });
});

describe("collapseEmptied", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3)];
  const grid = normalizeLayout(
    { preset: "grid2x2", focusedPane: "d", tabPane: { t1: "b", t2: "c", t3: "d" }, activeTab: {} },
    tabs,
    NONE
  );

  it("hands a grid's remaining panes to split-right, each keeping its place", () => {
    const fromA = collapseEmptied(grid, "a", tabs);
    assert.equal(fromA.preset, "split-right");
    assert.deepEqual(fromA.tabPane, { t1: "b", t2: "a", t3: "c" });
    assert.deepEqual(fromA.activeTab, { a: "t2", b: "t1", c: "t3" });
    assert.equal(fromA.focusedPane, "c", "focus follows its pane");
    const fromC = collapseEmptied({ ...grid, tabPane: { t1: "a", t2: "b", t3: "d" } }, "c", tabs);
    assert.deepEqual(fromC.tabPane, { t1: "a", t2: "b", t3: "c" });
  });

  it("keeps an empty pane the user did not touch", () => {
    // a and c occupied, b and d empty; c's tab moved into d, so c is what was emptied.
    const moved = normalizeLayout(
      { preset: "grid2x2", focusedPane: "d", tabPane: { t1: "a", t2: "d" }, activeTab: {} },
      tabs.slice(0, 2),
      NONE
    );
    const next = collapseEmptied(moved, "c", tabs.slice(0, 2));
    assert.equal(next.preset, "split-right");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "c" });
    assert.deepEqual(next.activeTab, { a: "t1", b: null, c: "t2" }, "b stays, empty");
  });

  it("takes the empty panes at the end of the reading order along, never one before an occupied", () => {
    // LO, RO, LU occupied, RU empty; LU's tab moved up into RO, so LU is what was emptied.
    const moved = normalizeLayout(
      { preset: "grid2x2", focusedPane: "b", tabPane: { t1: "a", t2: "b", t3: "b" }, activeTab: {} },
      tabs,
      NONE
    );
    const next = collapseEmptied(moved, "c", tabs);
    assert.equal(next.preset, "cols2", "the empty RU under the occupied RO went too");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "b", t3: "b" });
    // LO and LU occupied, RO and RU empty; LU's tab moved up into LO: the right column goes.
    const up = normalizeLayout(
      { preset: "grid2x2", focusedPane: "a", tabPane: { t1: "a", t2: "a", t3: "a" }, activeTab: {} },
      tabs,
      NONE
    );
    const single = collapseEmptied(up, "c", tabs);
    assert.equal(single.preset, "single");
    assert.deepEqual(single.tabPane, { t1: "a", t2: "a", t3: "a" });
    // The same grid with the tab moved down into RU instead: the empty RO before it stays.
    const down = normalizeLayout(
      { preset: "grid2x2", focusedPane: "d", tabPane: { t1: "a", t2: "d", t3: "d" }, activeTab: {} },
      tabs,
      NONE
    );
    const kept = collapseEmptied(down, "c", tabs);
    assert.equal(kept.preset, "split-right");
    assert.deepEqual(kept.activeTab, { a: "t1", b: null, c: "t3" });
  });

  it("stays a grid with b or d empty, having no split-left preset to fall to", () => {
    assert.equal(collapseEmptied(grid, "b", tabs), grid);
    assert.equal(collapseEmptied(grid, "d", tabs), grid);
  });

  it("falls to cols2 from three panes and to single from two, in reading order", () => {
    const split = normalizeLayout(
      { preset: "split-right", focusedPane: "c", tabPane: { t1: "a", t2: "b", t3: "c" }, activeTab: {} },
      tabs,
      NONE
    );
    assert.deepEqual(collapseEmptied(split, "a", tabs).tabPane, { t1: "a", t2: "a", t3: "b" });
    assert.equal(collapseEmptied(split, "b", tabs).preset, "cols2");
    assert.deepEqual(collapseEmptied(split, "b", tabs).tabPane, { t1: "a", t2: "b", t3: "b" });
    assert.equal(collapseEmptied(split, "c", tabs).preset, "cols2");
    const cols2 = normalizeLayout(
      { preset: "cols2", focusedPane: "b", tabPane: { t1: "b", t2: "b", t3: "b" }, activeTab: { b: "t2" } },
      tabs,
      NONE
    );
    const single = collapseEmptied(cols2, "a", tabs);
    assert.equal(single.preset, "single");
    assert.deepEqual(single.tabPane, { t1: "a", t2: "a", t3: "a" });
    assert.deepEqual(single.activeTab, { a: "t2" });
    assert.equal(single.focusedPane, "a");
  });
});

describe("activateTab", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3)];
  const split = normalizeLayout(
    { preset: "split-right", focusedPane: "c", tabPane: { t1: "a", t2: "b", t3: "c" }, activeTab: {} },
    tabs,
    NONE
  );

  it("collapses the pane the move emptied, and only then", () => {
    const next = activateTab(split, "t3", "b", tabs);
    assert.equal(next.preset, "cols2");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "b", t3: "b" });
    assert.equal(activateTab(split, "t3", "c", tabs).preset, "split-right", "a plain activation");
  });

  it("does not take a tab activated ahead of its push for one that emptied the focused pane", () => {
    // b is focused and empty: the new tab resolves there, but nothing left b.
    const emptyB = normalizeLayout({ ...split, focusedPane: "b", tabPane: { t1: "a", t2: "a", t3: "c" } }, tabs, NONE);
    assert.equal(activateTab(emptyB, "new-1", "c", tabs).preset, "split-right");
  });
});

describe("collapseEmpty", () => {
  const tabs = [tab("t1", 1), tab("t2", 2)];
  const grid = (tabPane: Record<string, "a" | "b" | "c" | "d">): ProjectLayout =>
    normalizeLayout({ preset: "grid2x2", focusedPane: "a", tabPane, activeTab: {} }, tabs, NONE);

  it("takes every empty pane the transitions can take, in reading order", () => {
    // LO and RO occupied: LU goes, then the RU that trails.
    const cols2 = collapseEmpty(grid({ t1: "a", t2: "b" }), tabs);
    assert.equal(cols2.preset, "cols2");
    assert.deepEqual(cols2.tabPane, { t1: "a", t2: "b" });
    // LO and LU occupied: RO and RU have no transition without a split-left, both stay.
    assert.equal(collapseEmpty(grid({ t1: "a", t2: "c" }), tabs).preset, "grid2x2");
    // Stricter than a run: an empty RO above an occupied RU goes too.
    const split = normalizeLayout(
      { preset: "split-right", focusedPane: "c", tabPane: { t1: "a", t2: "c" }, activeTab: {} },
      tabs,
      NONE
    );
    const tidy = collapseEmpty(split, tabs);
    assert.equal(tidy.preset, "cols2");
    assert.deepEqual(tidy.tabPane, { t1: "a", t2: "b" });
  });

  it("is the same layout when nothing is empty", () => {
    const full = normalizeLayout({ preset: "cols2", focusedPane: "a", tabPane: { t1: "a", t2: "b" }, activeTab: {} }, tabs, NONE);
    assert.equal(collapseEmpty(full, tabs), full);
  });
});

describe("collapseClosed", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3)];
  const split = normalizeLayout(
    { preset: "split-right", focusedPane: "c", tabPane: { t1: "a", t2: "b", t3: "c" }, activeTab: {} },
    tabs,
    NONE
  );

  it("collapses the pane whose last tab closed", () => {
    const remaining = [tab("t1", 1), tab("t3", 3)];
    const next = collapseClosed(split, remaining, tabs);
    assert.equal(next.preset, "cols2");
    assert.deepEqual(next.tabPane, { t1: "a", t3: "b" });
    assert.equal(next.focusedPane, "b");
  });

  it("leaves a pane alone that never had a tab, or still has one", () => {
    const withMore = [...tabs, tab("t4", 4)];
    assert.deepEqual(collapseClosed(split, withMore, tabs), normalizeLayout(split, withMore, tabs), "a tab opened");
    const restored: ProjectLayout = { ...defaultLayout(), preset: "cols2", tabPane: { later: "b" } };
    const first = [tab("t1")];
    assert.equal(collapseClosed(restored, first, NONE).preset, "cols2", "b is still waiting for its listing");
    const closedOne = [tab("t1", 1), tab("t2", 2)];
    const stillC: ProjectLayout = { ...split, tabPane: { t1: "a", t2: "c", t3: "c" } };
    assert.equal(collapseClosed(stillC, closedOne, tabs).preset, "split-right", "c kept a tab");
  });

  it("takes several emptied panes in one push, translating letters as it goes", () => {
    const only = [tab("t2", 2)];
    const next = collapseClosed(split, only, tabs);
    assert.equal(next.preset, "single");
    assert.deepEqual(next.tabPane, { t2: "a" });
  });
});

describe("snapTab", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3), tab("t4", 4)];
  const single = normalizeLayout({ ...defaultLayout(), activeTab: { a: "t2" } }, tabs, NONE);
  const cols2 = normalizeLayout(
    { preset: "cols2", focusedPane: "a", tabPane: { t1: "a", t2: "a", t3: "b", t4: "b" }, activeTab: {} },
    tabs,
    NONE
  );

  it("splits a single pane to the right, taking only the dragged tab along", () => {
    const next = snapTab(single, "t3", SNAP_TRANSITIONS.single.right!, tabs);
    assert.equal(next.preset, "cols2");
    assert.equal(next.focusedPane, "b");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "a", t3: "b", t4: "a" });
    assert.deepEqual(next.activeTab, { a: "t2", b: "t3" });
  });

  it("lays out the whole preset from a single pane, leaving the panes it did not ask for empty", () => {
    const bottomRight = snapTab(single, "t3", SNAP_TRANSITIONS.single["bottom-right"]!, tabs);
    assert.equal(bottomRight.preset, "split-right");
    assert.deepEqual(bottomRight.tabPane, { t1: "a", t2: "a", t3: "c", t4: "a" });
    assert.deepEqual(bottomRight.activeTab, { a: "t2", b: null, c: "t3" });
    const topRight = snapTab(single, "t3", SNAP_TRANSITIONS.single["top-right"]!, tabs);
    assert.deepEqual(topRight.activeTab, { a: "t2", b: "t3", c: null });
    const bottomLeft = snapTab(single, "t3", SNAP_TRANSITIONS.single["bottom-left"]!, tabs);
    assert.equal(bottomLeft.preset, "grid2x2");
    assert.deepEqual(bottomLeft.activeTab, { a: "t2", b: null, c: "t3", d: null });
  });

  it("places a tab into a pane the preset already has, leaving what it emptied standing", () => {
    const split = normalizeLayout(
      { preset: "split-right", focusedPane: "b", tabPane: { t1: "a", t2: "b", t3: "c" }, activeTab: {} },
      tabs.slice(0, 3),
      NONE
    );
    const next = snapTab(split, "t2", SNAP_TRANSITIONS["split-right"]["bottom-right"]!, tabs.slice(0, 3));
    assert.equal(next.preset, "split-right");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "c", t3: "c" });
    assert.deepEqual(next.activeTab, { a: "t1", b: null, c: "t2" }, "b stays, empty");
    assert.equal(next.focusedPane, "c");
  });

  it("does not collapse a source pane the snap emptied", () => {
    const onlyTab = normalizeLayout({ ...defaultLayout(), tabPane: { t1: "a" } }, [tab("t1")], NONE);
    const next = snapTab(onlyTab, "t1", SNAP_TRANSITIONS.single.right!, [tab("t1")]);
    assert.equal(next.preset, "cols2");
    assert.deepEqual(next.activeTab, { a: null, b: "t1" });
  });

  it("places into the right column, or adds a pane below b, from two", () => {
    const right = snapTab(cols2, "t1", SNAP_TRANSITIONS.cols2.right!, tabs);
    assert.equal(right.preset, "cols2", "the right column is already there");
    assert.deepEqual(right.tabPane, { t1: "b", t2: "a", t3: "b", t4: "b" });
    assert.deepEqual(right.activeTab, { a: "t2", b: "t1" });
    const split = snapTab(cols2, "t1", SNAP_TRANSITIONS.cols2["bottom-right"]!, tabs);
    assert.equal(split.preset, "split-right");
    assert.deepEqual(split.tabPane, { t1: "c", t2: "a", t3: "b", t4: "b" });
    assert.deepEqual(split.activeTab, { a: "t2", b: "t4", c: "t1" });
  });

  it("makes room top right by moving b's tabs below", () => {
    const split = snapTab(cols2, "t1", SNAP_TRANSITIONS.cols2["top-right"]!, tabs);
    assert.equal(split.preset, "split-right");
    assert.deepEqual(split.tabPane, { t1: "b", t2: "a", t3: "c", t4: "c" });
    assert.deepEqual(split.activeTab, { a: "t2", b: "t1", c: "t4" }, "b's selection went along");
  });

  it("splits the left column into a grid, leaving d empty", () => {
    const grid = snapTab(cols2, "t1", SNAP_TRANSITIONS.cols2["bottom-left"]!, tabs);
    assert.equal(grid.preset, "grid2x2");
    assert.deepEqual(grid.tabPane, { t1: "c", t2: "a", t3: "b", t4: "b" });
    assert.deepEqual(grid.activeTab, { a: "t2", b: "t4", c: "t1", d: null });
  });

  it("moves split-right's lower pane down to d when a is split, keeping its selection", () => {
    const split = normalizeLayout(
      {
        preset: "split-right",
        focusedPane: "c",
        tabPane: { t1: "a", t2: "a", t3: "b", t4: "c" },
        activeTab: { a: "t1" }
      },
      tabs,
      NONE
    );
    const grid = snapTab(split, "t2", SNAP_TRANSITIONS["split-right"]["bottom-left"]!, tabs);
    assert.equal(grid.preset, "grid2x2");
    assert.deepEqual(grid.tabPane, { t1: "a", t2: "c", t3: "b", t4: "d" });
    assert.deepEqual(grid.activeTab, { a: "t1", b: "t3", c: "t2", d: "t4" });
  });
});

describe("snapZoneAt", () => {
  it("reads the map of the grid, and only the zones the preset has a switch for", () => {
    assert.equal(snapZoneAt("single", { x: 0.8, y: 0.5 }, null)?.transition.preset, "cols2");
    assert.equal(snapZoneAt("single", { x: 0.8, y: 0.1 }, null)?.zone, "top-right");
    assert.equal(snapZoneAt("single", { x: 0.8, y: 0.9 }, null)?.zone, "bottom-right");
    assert.equal(snapZoneAt("single", { x: 0.2, y: 0.9 }, null)?.transition.preset, "grid2x2");
    assert.equal(snapZoneAt("single", { x: 0.2, y: 0.2 }, null), null, "top left is pane a");
    assert.equal(snapZoneAt("single", { x: 0.6, y: 0.5 }, null), null, "the middle is a plain drop");
    assert.deepEqual(snapZoneAt("cols2", { x: 0.8, y: 0.5 }, null)?.transition, { preset: "cols2", target: "b", remap: {} });
    assert.equal(snapZoneAt("split-right", { x: 0.8, y: 0.5 }, null), null, "no full-height right pane");
    assert.equal(snapZoneAt("split-right", { x: 0.8, y: 0.9 }, null)?.transition.target, "c", "the pane itself");
    assert.equal(snapZoneAt("split-right", { x: 0.2, y: 0.8 }, null)?.zone, "bottom-left");
  });

  it("keeps the zone it shows a little past its boundary", () => {
    assert.equal(snapZoneAt("single", { x: 0.8, y: 0.34 }, "top-right")?.zone, "top-right");
    assert.equal(snapZoneAt("single", { x: 0.8, y: 0.34 }, null)?.zone, "right");
    assert.equal(snapZoneAt("single", { x: 0.8, y: 0.4 }, "top-right")?.zone, "right");
  });
});

describe("what is persisted", () => {
  const storage = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value)
  };

  it("is keyed by session id, without the active tabs or tabs that have no session", () => {
    const layout: ProjectLayout = {
      preset: "cols2",
      focusedPane: "b",
      tabPane: { "new-1": "a", "new-2": "b", "new-3": "b" },
      activeTab: { a: "new-1", b: "new-2" }
    };
    const serialized = serializeLayout(layout, [tab("new-1", 0, "s1"), tab("new-2", 0, "s2"), tab("new-3")]);
    assert.deepEqual(JSON.parse(serialized), { preset: "cols2", focusedPane: "b", tabPane: { s1: "a", s2: "b" } });
    storage.set("tet.layout.terminals.p.layout", serialized);
    assert.deepEqual(loadLayout("p"), {
      preset: "cols2",
      focusedPane: "b",
      tabPane: { s1: "a", s2: "b" },
      activeTab: {}
    });
  });

  it("falls back to a fresh layout for anything hand-edited into the wrong shape", () => {
    assert.deepEqual(loadLayout("none"), defaultLayout());
    storage.set("tet.layout.terminals.q.layout", "{ nope");
    assert.deepEqual(loadLayout("q"), defaultLayout());
    storage.set("tet.layout.terminals.q.layout", JSON.stringify({ preset: "cols9", focusedPane: "a", tabPane: {} }));
    assert.deepEqual(loadLayout("q"), defaultLayout());
    storage.set(
      "tet.layout.terminals.q.layout",
      JSON.stringify({ preset: "cols2", focusedPane: "a", tabPane: { s: "z", t: "b" } })
    );
    assert.deepEqual(loadLayout("q").tabPane, { t: "b" }, "an unknown pane is dropped, the rest kept");
  });
});
