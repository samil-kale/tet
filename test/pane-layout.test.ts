import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SNAP_TRANSITIONS,
  applyPreset,
  defaultLayout,
  loadLayout,
  moveTab,
  normalizeLayout,
  occupiedPanes,
  serializeLayout,
  settleLayout,
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

describe("settleLayout", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3)];

  it("counts occupied panes in reading order", () => {
    const grid: ProjectLayout = { preset: "grid2x2", focusedPane: "d", tabPane: { t1: "b", t2: "d" }, activeTab: {} };
    assert.deepEqual(occupiedPanes(grid, tabs.slice(0, 2)), ["b", "d"]);
    assert.deepEqual(occupiedPanes(grid, NONE), []);
  });

  it("is the preset for the count: one is single, two are cols2, whatever they were", () => {
    const split = normalizeLayout(
      { preset: "split-right", focusedPane: "c", tabPane: { t1: "b", t2: "c", t3: "c" }, activeTab: { c: "t2" } },
      tabs,
      NONE
    );
    const cols2 = settleLayout(split, tabs);
    assert.equal(cols2.preset, "cols2");
    assert.deepEqual(cols2.tabPane, { t1: "a", t2: "b", t3: "b" });
    assert.deepEqual(cols2.activeTab, { a: "t1", b: "t2" }, "selections went along");
    assert.equal(cols2.focusedPane, "b", "focus followed its pane");
    const onlyD = normalizeLayout(
      { preset: "grid2x2", focusedPane: "a", tabPane: { t1: "d", t2: "d", t3: "d" }, activeTab: {} },
      tabs,
      NONE
    );
    const single = settleLayout(onlyD, tabs);
    assert.equal(single.preset, "single");
    assert.deepEqual(single.tabPane, { t1: "a", t2: "a", t3: "a" });
    assert.equal(single.focusedPane, "a");
    assert.equal(settleLayout(normalizeLayout({ ...defaultLayout(), preset: "cols2" }, NONE, NONE), NONE).preset, "single");
  });

  it("makes three panes of the grid a split-right, in reading order, whichever corner is empty", () => {
    const grid = normalizeLayout(
      { preset: "grid2x2", focusedPane: "a", tabPane: { t1: "a", t2: "c", t3: "d" }, activeTab: {} },
      tabs,
      NONE
    );
    const split = settleLayout(grid, tabs);
    assert.equal(split.preset, "split-right");
    assert.deepEqual(split.tabPane, { t1: "a", t2: "b", t3: "c" });
    const bEmpty = settleLayout({ ...grid, tabPane: { t1: "a", t2: "b", t3: "d" } }, tabs);
    assert.deepEqual(bEmpty.tabPane, { t1: "a", t2: "b", t3: "c" });
  });

  it("leaves a layout alone that already is the preset for its count", () => {
    const cols3 = normalizeLayout(
      { preset: "cols3", focusedPane: "c", tabPane: { t1: "a", t2: "b", t3: "c" }, activeTab: {} },
      tabs,
      NONE
    );
    assert.equal(settleLayout(cols3, tabs), cols3);
    const cols2 = normalizeLayout({ preset: "cols2", focusedPane: "a", tabPane: { t1: "a", t2: "b" }, activeTab: {} }, tabs, NONE);
    assert.equal(settleLayout(cols2, tabs), cols2);
  });

  it("keeps the reading order of the occupied panes when they move down a preset", () => {
    const cols3 = normalizeLayout(
      { preset: "cols3", focusedPane: "c", tabPane: { t1: "b", t2: "c", t3: "c" }, activeTab: {} },
      tabs,
      NONE
    );
    assert.deepEqual(settleLayout(cols3, tabs).tabPane, { t1: "a", t2: "b", t3: "b" });
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

  it("does not settle a source pane the snap emptied", () => {
    const onlyTab = normalizeLayout({ ...defaultLayout(), tabPane: { t1: "a" } }, [tab("t1")], NONE);
    const next = snapTab(onlyTab, "t1", SNAP_TRANSITIONS.single.right!, [tab("t1")]);
    assert.equal(next.preset, "cols2");
    assert.deepEqual(next.activeTab, { a: null, b: "t1" });
  });

  it("adds a third column, or a pane below b, from two", () => {
    const cols3 = snapTab(cols2, "t4", SNAP_TRANSITIONS.cols2.right!, tabs);
    assert.equal(cols3.preset, "cols3");
    assert.deepEqual(cols3.tabPane, { t1: "a", t2: "a", t3: "b", t4: "c" });
    assert.deepEqual(cols3.activeTab, { a: "t2", b: "t3", c: "t4" });
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
    assert.equal(snapZoneAt("cols3", { x: 0.8, y: 0.5 }, null), null, "nothing left to add");
    assert.equal(snapZoneAt("split-right", { x: 0.8, y: 0.5 }, null), null);
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
