import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  SNAP_TRANSITIONS,
  activateTab,
  activeEditorTab,
  collapseClosed,
  collapseEmptied,
  collapseEmpty,
  defaultLayout,
  inOrder,
  loadLayout,
  loadPersisted,
  moveTab,
  normalizeLayout,
  placeCommandTab,
  dropOnStrip,
  serializeLayout,
  snapTab,
  snapZoneAt,
  tabsOnScreen,
  visibleTabIds,
} from "../../src/renderer/tabs/pane-layout";
import type { ProjectLayout } from "../../src/renderer/tabs/pane-layout";
import type { TabDescriptor } from "../../src/shared/types/terminals";
import { nextEditorTabId, type EditorEntry, type EditorTab } from "../../src/renderer/editor/editor-tab";
import { fakeLocalStorage, keepGlobals } from "../helpers";

/** The split view's rules — pure functions, needing no window. */

function tab(tabId: string, updatedAt?: number, sessionId?: string): TabDescriptor {
  return { tabId, agentId: "claude", title: "", status: "running", updatedAt, sessionId };
}

const NONE: TabDescriptor[] = [];

/** No editor tab here to describe. */
const NO_EDITOR = (): undefined => undefined;

/** A layout of `preset` as the first push of `tabs` settles it. */
function layoutOf(
  preset: ProjectLayout["preset"],
  focusedPane: ProjectLayout["focusedPane"],
  tabPane: ProjectLayout["tabPane"],
  tabs: (TabDescriptor | EditorTab)[],
  activeTab: ProjectLayout["activeTab"] = {},
  commandPane: ProjectLayout["commandPane"] = {},
): ProjectLayout {
  return normalizeLayout({ preset, focusedPane, tabPane, activeTab, order: [], recent: [], commandPane }, tabs, NONE, false);
}

describe("tabsOnScreen", () => {
  it("is every pane's shown tab, and none without the focus or under a dialog", () => {
    const layout: ProjectLayout = {
      ...defaultLayout(),
      preset: "cols2",
      tabPane: { t1: "a", t2: "b", t3: "b" },
      activeTab: { a: "t1", b: "t2" },
    };
    assert.deepEqual(tabsOnScreen(layout, true, false), ["t1", "t2"]);
    assert.deepEqual(tabsOnScreen(layout, false, false), [], "another window in front, or minimized");
    assert.deepEqual(tabsOnScreen(layout, true, true), [], "a dialog over the window");
  });
});

describe("normalizeLayout", () => {
  it("settles a new tab in the focused pane and opens on the most recently used one", () => {
    const layout: ProjectLayout = { ...defaultLayout(), preset: "cols2", focusedPane: "b" };
    const tabs = [tab("t1", 10), tab("t2", 30), tab("t3", 20)];
    const next = normalizeLayout(layout, tabs, NONE, false);
    assert.deepEqual(next.tabPane, { t1: "b", t2: "b", t3: "b" });
    assert.deepEqual(next.activeTab, { a: null, b: "t2" });
    assert.deepEqual(visibleTabIds(next), ["t2"]);
  });

  it("answers the same object when nothing changed", () => {
    const tabs = [tab("t1")];
    const once = normalizeLayout(defaultLayout(), tabs, NONE, false);
    assert.equal(normalizeLayout(once, tabs, tabs, false), once);
  });

  it("moves a pane's selection to the right neighbour, or left from the end", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3")];
    const layout = normalizeLayout({ ...defaultLayout(), activeTab: { a: "t2" } }, tabs, NONE, false);
    const withoutT2 = [tab("t1"), tab("t3")];
    assert.equal(normalizeLayout(layout, withoutT2, tabs, false).activeTab.a, "t3");
    const onT3 = { ...layout, activeTab: { a: "t3" } };
    assert.equal(normalizeLayout(onT3, [tab("t1"), tab("t2")], tabs, false).activeTab.a, "t2");
    assert.equal(normalizeLayout(onT3, NONE, tabs, false).activeTab.a, null);
  });

  it("moves the selection to the neighbour in a pane without the focus too", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3")];
    const layout: ProjectLayout = {
      ...defaultLayout(),
      preset: "cols2",
      tabPane: { t1: "a", t2: "b", t3: "b" },
      activeTab: { a: "t1", b: "t2" },
    };
    assert.deepEqual(normalizeLayout(layout, [tab("t1"), tab("t3")], tabs, false).activeTab, { a: "t1", b: "t3" });
  });

  it("leaves a selection alone that names a tab not pushed yet, and drops a closed tab's pane", () => {
    const tabs = [tab("t1")];
    const layout: ProjectLayout = { ...defaultLayout(), tabPane: { t1: "a", gone: "a" }, activeTab: { a: "new-9" } };
    const next = normalizeLayout(layout, tabs, [tab("t1"), tab("gone")], false);
    assert.equal(next.activeTab.a, "new-9", "activated before its push arrived");
    assert.deepEqual(next.tabPane, { t1: "a" });
  });

  it("keeps a restored assignment for a tab whose listing has not come yet", () => {
    const layout: ProjectLayout = { ...defaultLayout(), preset: "cols2", tabPane: { later: "b", elsewhere: "c" } };
    const next = normalizeLayout(layout, NONE, NONE, false);
    assert.deepEqual(next.tabPane, { later: "b" }, "a pane the preset does not have is dropped");
    assert.equal(next.focusedPane, "a");
  });

  it("settles a new tab in a pane the preset has, when the focused one is not", () => {
    const layout: ProjectLayout = { ...defaultLayout(), preset: "single", focusedPane: "c" };
    const next = normalizeLayout(layout, [tab("t1")], NONE, false);
    assert.deepEqual(next.tabPane, { t1: "a" });
    assert.deepEqual(next.activeTab, { a: "t1" });
    assert.equal(next.focusedPane, "a");
  });
});

describe("the most recent tab", () => {
  const tabs = [tab("t1"), tab("t2"), tab("t3"), tab("t4")];
  /** t2 shown last, after t4: the order VS Code's MRU would hold. */
  const used = (): ProjectLayout => {
    let layout = layoutOf("single", "a", {}, tabs, { a: "t1" });
    for (const tabId of ["t4", "t2"]) {
      layout = moveTab(layout, tabId, "a", tabs);
    }
    return layout;
  };

  it("is what a pane shows once its active tab closes, not the neighbour", () => {
    const closed = tabs.filter((candidate) => candidate.tabId !== "t2");
    assert.equal(normalizeLayout(used(), closed, tabs, false).activeTab.a, "t4");
  });

  it("is what the pane left behind shows when its active tab moves away", () => {
    const layout = activateTab({ ...used(), preset: "cols2" }, "t2", "b", tabs);
    assert.equal(layout.activeTab.a, "t4");
    assert.deepEqual(layout.recent.slice(0, 2), ["t2", "t4"]);
  });

  it("is written under the persisted ids and read back", () => {
    const sessions = [tab("t1", 0, "s1"), tab("t2", 0, "s2"), tab("t3")];
    const layout = { ...layoutOf("single", "a", {}, sessions), recent: ["t3", "t2", "t1"] };
    assert.deepEqual((JSON.parse(serializeLayout(layout, sessions, NO_EDITOR)) as { recent: unknown }).recent, ["s2", "s1"]);
  });
});

describe("the strip's order", () => {
  const settled = (): ProjectLayout => layoutOf("single", "a", {}, [tab("t1"), tab("t2"), tab("t3")], { a: "t2" });

  it("puts a new tab right of its pane's active one, several in the order they came", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3")];
    const next = normalizeLayout(settled(), [...tabs, tab("n1"), tab("n2")], tabs, false);
    assert.deepEqual(next.order, ["t1", "t2", "n1", "n2", "t3"]);
  });

  it("takes main's place for a tab while the sessions are listed", () => {
    const first = [tab("t1"), tab("t3")];
    const listed = normalizeLayout({ ...defaultLayout(), activeTab: { a: "t1" } }, first, NONE, true);
    const all = [tab("t1"), tab("t2"), tab("t3"), tab("t4")];
    assert.deepEqual(normalizeLayout(listed, all, first, true).order, ["t1", "t2", "t3", "t4"]);
  });

  it("keeps a restored place for a tab not listed yet, and drops a closed one's", () => {
    const layout: ProjectLayout = { ...defaultLayout(), order: ["s2", "s1", "gone"] };
    const next = normalizeLayout(layout, [tab("s1")], [tab("s1"), tab("gone")], true);
    assert.deepEqual(next.order, ["s2", "s1"]);
  });

  it("places a tab activated ahead of its push right of the target's active one", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3")];
    const moved = moveTab(settled(), "e1", "a", tabs);
    assert.deepEqual(moved.order, ["t1", "t2", "e1", "t3"]);
    assert.equal(normalizeLayout(moved, [...tabs, tab("e1")], tabs, false).order, moved.order);
  });

  it("shows a tab dropped on a strip before another, or behind its pane's last", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3"), tab("t4")];
    const layout = layoutOf("cols2", "a", { t1: "a", t2: "a", t3: "b", t4: "b" }, tabs);
    assert.deepEqual(dropOnStrip(layout, "t2", "a", "t1", tabs).order, ["t2", "t1", "t3", "t4"]);
    assert.deepEqual(dropOnStrip(layout, "t1", "b", "t4", tabs).order, ["t2", "t3", "t1", "t4"], "from another pane");
    assert.deepEqual(dropOnStrip(layout, "t1", "a", undefined, tabs).order, ["t2", "t1", "t3", "t4"]);
    assert.deepEqual(dropOnStrip(layout, "t1", "b", undefined, tabs).order, ["t2", "t3", "t4", "t1"]);
    const shown = dropOnStrip(layout, "t1", "b", "t4", tabs);
    assert.deepEqual([shown.tabPane.t1, shown.activeTab.b], ["b", "t1"]);
  });

  it("finds a dropped tab's place before the pane it leaves collapses", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3")];
    const layout = layoutOf("cols2", "a", { t1: "a", t2: "b", t3: "b" }, tabs);
    const dropped = dropOnStrip(layout, "t1", "b", undefined, tabs);
    assert.equal(dropped.preset, "single");
    assert.deepEqual(dropped.order, ["t2", "t3", "t1"]);
  });

  it("puts a tab moved to another pane right of that pane's active one", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3"), tab("t4")];
    const layout = layoutOf("cols2", "a", { t1: "a", t2: "a", t3: "b", t4: "b" }, tabs, { a: "t1", b: "t3" });
    assert.deepEqual(moveTab(layout, "t2", "b", tabs).order, ["t1", "t3", "t2", "t4"]);
    assert.equal(moveTab(layout, "t2", "a", tabs).order, layout.order, "a click where it lives moves nothing");
  });

  it("lists each tab in its place, one not placed yet behind", () => {
    assert.deepEqual(
      inOrder(["b", "a"], [tab("a"), tab("x"), tab("b")]).map((entry) => entry.tabId),
      ["b", "a", "x"],
    );
  });
});

describe("moveTab", () => {
  const tabs = [tab("t1"), tab("t2"), tab("t3"), tab("t4")];
  const cols2 = layoutOf("cols2", "a", { t1: "a", t2: "a", t3: "a", t4: "b" }, tabs, { a: "t2" });

  it("moves the tab, focuses the target, and leaves the source as a close would", () => {
    const next = moveTab(cols2, "t2", "b", tabs);
    assert.equal(next.focusedPane, "b");
    assert.equal(next.tabPane.t2, "b");
    assert.deepEqual(next.activeTab, { a: "t3", b: "t2" }, "none used before: the neighbour on the right");
    assert.equal(moveTab({ ...cols2, recent: ["t1"] }, "t2", "b", tabs).activeTab.a, "t1", "the most recent one");
    assert.equal(moveTab(cols2, "t1", "b", tabs).activeTab.a, "t2", "the first tab leaves the next one");
    assert.deepEqual(moveTab(cols2, "t4", "a", tabs).activeTab, { a: "t4", b: null }, "an emptied pane shows nothing");
  });

  it("is a plain activation within the same pane", () => {
    const next = moveTab(cols2, "t3", "a", tabs);
    assert.equal(next.tabPane, cols2.tabPane, "nothing reassigned");
    assert.deepEqual(next.activeTab, { a: "t3", b: "t4" });
  });
});

describe("placeCommandTab", () => {
  const command = (tabId: string, line: string): TabDescriptor => ({ ...tab(tabId), command: line });
  const split = (commandPane: ProjectLayout["commandPane"], tabs: TabDescriptor[]): ProjectLayout =>
    layoutOf("split-right", "a", { t1: "a", t2: "b" }, tabs, {}, commandPane);
  const tabs = [tab("t1"), tab("t2")];

  it("records the pane a command's tab closed in, and puts the next run back there", () => {
    const withCommand = [...tabs, command("c1", "npm test")];
    const running = normalizeLayout({ ...split({}, withCommand), tabPane: { t1: "a", t2: "b", c1: "c" } }, withCommand, NONE, false);
    const closed = normalizeLayout(running, tabs, withCommand, false);
    assert.deepEqual(closed.commandPane, { "npm test": { preset: "split-right", pane: "c" } });
    const again = [...tabs, command("c2", "npm test")];
    const placed = placeCommandTab(closed, "c2", "npm test", again);
    assert.equal(placed.tabPane.c2, "c");
    assert.equal(placed.focusedPane, "c");
    assert.equal(placed.preset, "split-right");
  });

  it("goes beside a tab of the same command that is still open", () => {
    const withCommand = [...tabs, command("c1", "npm test")];
    const running = normalizeLayout(
      { ...split({ "npm test": { preset: "split-right", pane: "c" } }, withCommand), tabPane: { t1: "a", t2: "b", c1: "b" } },
      withCommand,
      NONE,
      false,
    );
    const placed = placeCommandTab(running, "c2", "npm test", [...withCommand, command("c2", "npm test")]);
    assert.equal(placed.tabPane.c2, "b", "the open one wins over the record");
  });

  it("finds the pane by position across presets, or restores the preset where it is missing", () => {
    // Recorded bottom right in the grid; in split-right that is c.
    const fromGrid = placeCommandTab(split({ "npm test": { preset: "grid2x2", pane: "d" } }, tabs), "c1", "npm test", tabs);
    assert.equal(fromGrid.preset, "split-right");
    assert.equal(fromGrid.tabPane.c1, "c");
    // Recorded bottom left in the grid, which split-right lacks: the grid comes back, and
    // split-right's bottom right pane keeps its place as d.
    const layout = layoutOf("split-right", "a", { t1: "a", t2: "c" }, tabs, {}, { "npm test": { preset: "grid2x2", pane: "c" } });
    const restored = placeCommandTab(layout, "c1", "npm test", tabs);
    assert.equal(restored.preset, "grid2x2");
    assert.deepEqual(restored.tabPane, { t1: "a", t2: "d", c1: "c" });
    assert.equal(restored.activeTab.b, null, "the pane the preset adds stays empty");
  });

  it("lands in the focused pane like any new tab when nothing is recorded", () => {
    const layout = { ...split({}, tabs), focusedPane: "b" as const };
    assert.equal(placeCommandTab(layout, "c1", "npm test", tabs).tabPane.c1, "b");
  });
});

describe("collapseEmptied", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3)];
  const grid = layoutOf("grid2x2", "d", { t1: "b", t2: "c", t3: "d" }, tabs);

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
    const moved = layoutOf("grid2x2", "d", { t1: "a", t2: "d" }, tabs.slice(0, 2));
    const next = collapseEmptied(moved, "c", tabs.slice(0, 2));
    assert.equal(next.preset, "split-right");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "c" });
    assert.deepEqual(next.activeTab, { a: "t1", b: null, c: "t2" }, "b stays, empty");
  });

  it("takes the empty panes at the end of the reading order along, never one before an occupied", () => {
    // LO, RO, LU occupied, RU empty; LU's tab moved up into RO, so LU is what was emptied.
    const moved = layoutOf("grid2x2", "b", { t1: "a", t2: "b", t3: "b" }, tabs);
    const next = collapseEmptied(moved, "c", tabs);
    assert.equal(next.preset, "cols2", "the empty RU under the occupied RO went too");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "b", t3: "b" });
    // LO and LU occupied, RO and RU empty; LU's tab moved up into LO: the right column goes.
    const up = layoutOf("grid2x2", "a", { t1: "a", t2: "a", t3: "a" }, tabs);
    const single = collapseEmptied(up, "c", tabs);
    assert.equal(single.preset, "single");
    assert.deepEqual(single.tabPane, { t1: "a", t2: "a", t3: "a" });
    // The same grid with the tab moved down into RU instead: the empty RO before it stays.
    const down = layoutOf("grid2x2", "d", { t1: "a", t2: "d", t3: "d" }, tabs);
    const kept = collapseEmptied(down, "c", tabs);
    assert.equal(kept.preset, "split-right");
    assert.deepEqual(kept.activeTab, { a: "t1", b: null, c: "t3" });
  });

  it("stays a grid with b or d empty, having no split-left preset to fall to", () => {
    assert.equal(collapseEmptied(grid, "b", tabs), grid);
    assert.equal(collapseEmptied(grid, "d", tabs), grid);
  });

  it("falls to cols2 from three panes and to single from two, in reading order", () => {
    const split = layoutOf("split-right", "c", { t1: "a", t2: "b", t3: "c" }, tabs);
    assert.deepEqual(collapseEmptied(split, "a", tabs).tabPane, { t1: "a", t2: "a", t3: "b" });
    assert.equal(collapseEmptied(split, "b", tabs).preset, "cols2");
    assert.deepEqual(collapseEmptied(split, "b", tabs).tabPane, { t1: "a", t2: "b", t3: "b" });
    assert.equal(collapseEmptied(split, "c", tabs).preset, "cols2");
    const cols2 = layoutOf("cols2", "b", { t1: "b", t2: "b", t3: "b" }, tabs, { b: "t2" });
    const single = collapseEmptied(cols2, "a", tabs);
    assert.equal(single.preset, "single");
    assert.deepEqual(single.tabPane, { t1: "a", t2: "a", t3: "a" });
    assert.deepEqual(single.activeTab, { a: "t2" });
    assert.equal(single.focusedPane, "a");
  });
});

describe("activateTab", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3)];
  const split = layoutOf("split-right", "c", { t1: "a", t2: "b", t3: "c" }, tabs);

  it("collapses the pane the move emptied, and only then", () => {
    const next = activateTab(split, "t3", "b", tabs);
    assert.equal(next.preset, "cols2");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "b", t3: "b" });
    assert.equal(activateTab(split, "t3", "c", tabs).preset, "split-right", "a plain activation");
  });

  it("does not take a tab activated ahead of its push for one that emptied the focused pane", () => {
    // b is focused and empty: the new tab resolves there, but nothing left b.
    const emptyB = normalizeLayout({ ...split, focusedPane: "b", tabPane: { t1: "a", t2: "a", t3: "c" } }, tabs, NONE, false);
    assert.equal(activateTab(emptyB, "new-1", "c", tabs).preset, "split-right");
  });
});

describe("collapseEmpty", () => {
  const tabs = [tab("t1", 1), tab("t2", 2)];
  const grid = (tabPane: ProjectLayout["tabPane"]): ProjectLayout => layoutOf("grid2x2", "a", tabPane, tabs);

  it("takes every empty pane the transitions can take, in reading order", () => {
    // LO and RO occupied: LU goes, then the RU that trails.
    const cols2 = collapseEmpty(grid({ t1: "a", t2: "b" }), tabs);
    assert.equal(cols2.preset, "cols2");
    assert.deepEqual(cols2.tabPane, { t1: "a", t2: "b" });
    // LO and LU occupied: RO and RU have no transition without a split-left, both stay.
    assert.equal(collapseEmpty(grid({ t1: "a", t2: "c" }), tabs).preset, "grid2x2");
    // Stricter than a run: an empty RO above an occupied RU goes too.
    const split = layoutOf("split-right", "c", { t1: "a", t2: "c" }, tabs);
    const tidy = collapseEmpty(split, tabs);
    assert.equal(tidy.preset, "cols2");
    assert.deepEqual(tidy.tabPane, { t1: "a", t2: "b" });
  });

  it("is the same layout when nothing is empty", () => {
    const full = layoutOf("cols2", "a", { t1: "a", t2: "b" }, tabs);
    assert.equal(collapseEmpty(full, tabs), full);
  });
});

describe("collapseClosed", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3)];
  const split = layoutOf("split-right", "c", { t1: "a", t2: "b", t3: "c" }, tabs);

  it("collapses the pane whose last tab closed", () => {
    const remaining = [tab("t1", 1), tab("t3", 3)];
    const next = collapseClosed(split, remaining, tabs, false);
    assert.equal(next.preset, "cols2");
    assert.deepEqual(next.tabPane, { t1: "a", t3: "b" });
    assert.equal(next.focusedPane, "b");
  });

  it("leaves a pane alone that never had a tab, or still has one", () => {
    const withMore = [...tabs, tab("t4", 4)];
    assert.deepEqual(collapseClosed(split, withMore, tabs, false), normalizeLayout(split, withMore, tabs, false), "a tab opened");
    const restored: ProjectLayout = { ...defaultLayout(), preset: "cols2", tabPane: { later: "b" } };
    const first = [tab("t1")];
    assert.equal(collapseClosed(restored, first, NONE, false).preset, "cols2", "b is still waiting for its listing");
    const closedOne = [tab("t1", 1), tab("t2", 2)];
    const stillC: ProjectLayout = { ...split, tabPane: { t1: "a", t2: "c", t3: "c" } };
    assert.equal(collapseClosed(stillC, closedOne, tabs, false).preset, "split-right", "c kept a tab");
  });

  it("takes several emptied panes in one push, translating letters as it goes", () => {
    const only = [tab("t2", 2)];
    const next = collapseClosed(split, only, tabs, false);
    assert.equal(next.preset, "single");
    assert.deepEqual(next.tabPane, { t2: "a" });
  });
});

describe("snapTab", () => {
  const tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 3), tab("t4", 4)];
  const single = normalizeLayout({ ...defaultLayout(), activeTab: { a: "t2" } }, tabs, NONE, false);
  const cols2 = layoutOf("cols2", "a", { t1: "a", t2: "a", t3: "b", t4: "b" }, tabs);

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
    const split = layoutOf("split-right", "b", { t1: "a", t2: "b", t3: "c" }, tabs.slice(0, 3));
    const next = snapTab(split, "t2", SNAP_TRANSITIONS["split-right"]["bottom-right"]!, tabs.slice(0, 3));
    assert.equal(next.preset, "split-right");
    assert.deepEqual(next.tabPane, { t1: "a", t2: "c", t3: "c" });
    assert.deepEqual(next.activeTab, { a: "t1", b: null, c: "t2" }, "b stays, empty");
    assert.equal(next.focusedPane, "c");
  });

  it("does not collapse a source pane the snap emptied", () => {
    const onlyTab = normalizeLayout({ ...defaultLayout(), tabPane: { t1: "a" } }, [tab("t1")], NONE, false);
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
    const split = layoutOf("split-right", "c", { t1: "a", t2: "a", t3: "b", t4: "c" }, tabs, { a: "t1" });
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
  keepGlobals("localStorage");
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = fakeLocalStorage();
  });

  it("is keyed by session id, without tabs that have no session", () => {
    const layout: ProjectLayout = {
      preset: "cols2",
      focusedPane: "b",
      tabPane: { "new-1": "a", "new-2": "b", "new-3": "b" },
      activeTab: { a: "new-1", b: "new-3" },
      order: ["new-2", "new-1", "new-3"],
      recent: ["new-3", "new-2", "new-1"],
      commandPane: {},
    };
    const serialized = serializeLayout(layout, [tab("new-1", 0, "s1"), tab("new-2", 0, "s2"), tab("new-3")], NO_EDITOR);
    assert.deepEqual(JSON.parse(serialized), {
      preset: "cols2",
      focusedPane: "b",
      tabs: [
        { id: "s2", pane: "b", kind: "session" },
        { id: "s1", pane: "a", kind: "session" },
      ],
      activeTab: { a: "s1" },
      recent: ["s2", "s1"],
      commandPane: {},
    });
    storage.set("tet.layout.terminals.p.layout", serialized);
    assert.deepEqual(loadLayout("p"), {
      preset: "cols2",
      focusedPane: "b",
      tabPane: { s1: "a", s2: "b" },
      activeTab: { a: "s1" },
      order: ["s2", "s1"],
      recent: ["s2", "s1"],
      commandPane: {},
    });
  });

  it("keeps a pane on its restored active tab while the sessions are listed, and lets a stale one go", () => {
    storage.set(
      "tet.layout.terminals.a.layout",
      JSON.stringify({ preset: "single", focusedPane: "a", tabs: [], activeTab: { a: "s1" }, commandPane: {} }),
    );
    const restored = loadLayout("a");
    const first = [tab("s2", 20, "s2")];
    const waiting = normalizeLayout(restored, first, NONE, false);
    assert.equal(waiting.activeTab.a, "s1", "not listed yet, not taken over by the one that is");
    const both = [tab("s2", 20, "s2"), tab("s1", 10, "s1")];
    assert.equal(normalizeLayout(waiting, both, first, false).activeTab.a, "s1");
    assert.equal(collapseEmpty(waiting, first).activeTab.a, "s2", "never listed: the most recently used one");
  });

  it("drops a restored active tab of a pane the preset does not have, or not a session id", () => {
    storage.set(
      "tet.layout.terminals.b.layout",
      JSON.stringify({ preset: "cols2", focusedPane: "a", tabs: [], activeTab: { a: 3, b: "s1", c: "s2", z: "s3" } }),
    );
    assert.deepEqual(loadLayout("b").activeTab, { b: "s1" });
  });

  it("writes where each saved command lies, the open ones over the recorded ones", () => {
    const layout: ProjectLayout = {
      preset: "split-right",
      focusedPane: "c",
      tabPane: { "new-1": "c" },
      activeTab: {},
      order: ["new-1"],
      recent: [],
      commandPane: { "npm test": { preset: "cols2", pane: "b" }, "npm run build": { preset: "grid2x2", pane: "d" } },
    };
    const running: TabDescriptor = { ...tab("new-1"), command: "npm test" };
    const serialized = serializeLayout(layout, [running], NO_EDITOR);
    const { commandPane } = JSON.parse(serialized) as { commandPane: unknown };
    assert.deepEqual(commandPane, {
      "npm test": { preset: "split-right", pane: "c" },
      "npm run build": { preset: "grid2x2", pane: "d" },
    });
    storage.set("tet.layout.terminals.r.layout", serialized);
    assert.deepEqual(loadLayout("r").commandPane, commandPane);
    storage.set(
      "tet.layout.terminals.r.layout",
      JSON.stringify({ preset: "cols2", focusedPane: "a", tabs: [], commandPane: { x: { preset: "cols2", pane: "d" }, y: 3 } }),
    );
    assert.deepEqual(loadLayout("r").commandPane, {}, "a pane the preset does not have, or no place at all, is dropped");
  });

  it("falls back to a fresh layout for anything hand-edited into the wrong shape", () => {
    assert.deepEqual(loadLayout("none"), defaultLayout());
    storage.set("tet.layout.terminals.q.layout", "{ nope");
    assert.deepEqual(loadLayout("q"), defaultLayout());
    storage.set("tet.layout.terminals.q.layout", JSON.stringify({ preset: "cols9", focusedPane: "a", tabs: [] }));
    assert.deepEqual(loadLayout("q"), defaultLayout());
    storage.set("tet.layout.terminals.q.layout", JSON.stringify({ preset: "cols2", focusedPane: "a", tabPane: { t: "b" } }));
    assert.deepEqual(loadLayout("q"), defaultLayout(), "an earlier record, without its tabs, is none");
    storage.set(
      "tet.layout.terminals.q.layout",
      JSON.stringify({
        preset: "cols2",
        focusedPane: "a",
        tabs: [
          { id: "s", pane: "z", kind: "session" },
          { id: "t", pane: "b", kind: "session" },
          { id: "u", pane: "b", kind: "saved command" },
          { id: "e", pane: "a", kind: "editor" },
        ],
      }),
    );
    assert.deepEqual(loadLayout("q").tabPane, { t: "b" }, "an unknown pane or kind, or an editor without its file, is dropped");
    storage.set("tet.layout.terminals.q.layout", JSON.stringify({ preset: "single", focusedPane: "c", tabs: [] }));
    assert.equal(loadLayout("q").focusedPane, "a", "a focused pane the preset does not have");
  });

  it("brings back an editor tab's file and editor, and a plain shell, beside the sessions", () => {
    const entry: EditorEntry = { path: "a.md", preview: true, diff: false, markdownPreview: "side", viewState: { cursor: 3 } };
    const shell: TabDescriptor = { ...tab("sh"), agentId: "shell" };
    const editorTab: EditorTab = { tabId: "tet:editor:x-1", ref: { projectId: "p" }, path: "a.md" };
    const tabs = [tab("t1", 0, "s1"), editorTab, shell];
    const layout = layoutOf("cols2", "a", { t1: "a", [editorTab.tabId]: "b", sh: "b" }, tabs);
    storage.set(
      "tet.layout.terminals.e.layout",
      serializeLayout(layout, tabs, () => entry),
    );
    assert.deepEqual(loadPersisted("e").tabs, [
      { id: "s1", pane: "a", kind: "session" },
      { id: editorTab.tabId, pane: "b", kind: "editor", editor: { ...entry, commit: undefined } },
      { id: "sh", pane: "b", kind: "shell" },
    ]);
  });
});

describe("an editor tab", () => {
  const EDITOR_TAB_ID = nextEditorTabId();
  const editor: EditorTab = { tabId: EDITOR_TAB_ID, ref: { projectId: "p" }, path: "src/index.ts" };
  const cols2 = (tabPane: ProjectLayout["tabPane"], tabs: (TabDescriptor | EditorTab)[]): ProjectLayout =>
    layoutOf("cols2", "a", tabPane, tabs);

  it("settles in the focused pane like any tab", () => {
    const layout = layoutOf("cols2", "b", { t1: "a" }, [tab("t1"), editor]);
    assert.equal(layout.tabPane[EDITOR_TAB_ID], "b");
    assert.equal(layout.activeTab.b, EDITOR_TAB_ID);
  });

  it("is written to disk under its own id, having no session, as a plain shell is and a saved command is not", () => {
    const shell: TabDescriptor = { ...tab("sh"), agentId: "shell" };
    const command: TabDescriptor = { ...shell, tabId: "cmd", command: "npm test" };
    const tabs = [tab("t1", 0, "s1"), editor, shell, command];
    const layout = cols2({ t1: "a", [EDITOR_TAB_ID]: "b", sh: "b", cmd: "b" }, tabs);
    const entry: EditorEntry = { path: editor.path, preview: false, diff: false, markdownPreview: "off" };
    const { tabs: written } = JSON.parse(serializeLayout(layout, tabs, () => entry)) as { tabs: { id: string; kind: string }[] };
    assert.deepEqual(
      written.map(({ id, kind }) => [id, kind]),
      [
        ["s1", "session"],
        [EDITOR_TAB_ID, "editor"],
        ["sh", "shell"],
      ],
    );
  });

  it("holds its pane: closing it collapses the pane, closing a neighbour beside it does not", () => {
    const alone = [tab("t1", 1), editor];
    assert.equal(collapseClosed(cols2({ t1: "a", [EDITOR_TAB_ID]: "b" }, alone), [tab("t1", 1)], alone, false).preset, "single");
    const beside = [tab("t1", 1), tab("t2", 2), editor];
    const layout = cols2({ t1: "a", t2: "b", [EDITOR_TAB_ID]: "b" }, beside);
    assert.equal(collapseClosed(layout, [tab("t1", 1), editor], beside, false).preset, "cols2");
  });

  it("empties its pane when moved out as the last tab, and keeps it standing otherwise", () => {
    const alone = [tab("t1", 1), editor];
    assert.equal(activateTab(cols2({ t1: "a", [EDITOR_TAB_ID]: "b" }, alone), EDITOR_TAB_ID, "a", alone).preset, "single");
    const beside = [tab("t1", 1), tab("t2", 2), editor];
    const layout = cols2({ t1: "a", t2: "b", [EDITOR_TAB_ID]: "b" }, beside);
    assert.equal(activateTab(layout, "t2", "a", beside).preset, "cols2");
  });

  it("counts as occupying its pane at startup", () => {
    const tabs = [tab("t1", 1), editor];
    assert.equal(collapseEmpty(cols2({ t1: "a", [EDITOR_TAB_ID]: "b" }, tabs), tabs).preset, "cols2");
  });

  it("is the active one when shown in the focused pane, else the first on screen, else the last kept", () => {
    const e2 = nextEditorTabId();
    const editors = [EDITOR_TAB_ID, e2];
    const tabs = [tab("t1", 1), editor, { ...editor, tabId: e2 }];
    const layout = cols2({ t1: "a", [EDITOR_TAB_ID]: "a", [e2]: "b" }, tabs);
    assert.equal(activeEditorTab({ ...layout, activeTab: { a: EDITOR_TAB_ID, b: e2 } }, editors, undefined), EDITOR_TAB_ID);
    assert.equal(activeEditorTab({ ...layout, activeTab: { a: "t1", b: e2 } }, editors, undefined), e2);
    assert.equal(activeEditorTab({ ...layout, activeTab: { a: "t1", b: null } }, editors, EDITOR_TAB_ID), EDITOR_TAB_ID);
    assert.equal(activeEditorTab({ ...layout, activeTab: { a: "t1", b: null } }, editors, "closed"), e2);
    assert.equal(activeEditorTab(layout, [], undefined), undefined);
  });
});
