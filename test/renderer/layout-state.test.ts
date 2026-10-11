import * as assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  activateIn,
  forgetPersistence,
  layoutOf,
  newLayoutPersistence,
  persistLayouts,
  reconcileLayouts,
  settleLayout,
} from "../../src/renderer/tabs/layout-state";
import { defaultLayout, layoutStorageKey } from "../../src/renderer/tabs/pane-layout";
import type { LayoutTab, ProjectLayout } from "../../src/renderer/tabs/pane-layout";
import { fakeLocalStorage } from "../helpers";

/** tabs/layout-state.ts: when a project's split layout is loaded, reconciled and written. */

function tab(tabId: string, sessionId?: string): LayoutTab {
  return { tabId, sessionId };
}

/** Two columns, `a` holding tab "x" and `b` holding tab "y". */
function twoColumns(): ProjectLayout {
  return {
    preset: "cols2",
    focusedPane: "a",
    tabPane: { x: "a", y: "b" },
    activeTab: { a: "x", b: "y" },
    commandPane: {},
  };
}

let storage: Map<string, string>;

/** What was written for project "p". */
const written = (): { preset: string; tabPane: Record<string, string> } =>
  JSON.parse(storage.get(KEY)!) as { preset: string; tabPane: Record<string, string> };

beforeEach(() => {
  storage = fakeLocalStorage();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const KEY = layoutStorageKey("p", "layout");

describe("a layout at its first sight", () => {
  it("is what the last run saved, not a default written over it", () => {
    storage.set(KEY, JSON.stringify({ preset: "cols2", focusedPane: "b", tabPane: {}, activeTab: {}, commandPane: {} }));
    assert.equal(layoutOf({}, "p").preset, "cols2");
    assert.equal(storage.get(KEY) !== undefined, true, "and what was saved is still there");
  });

  it("is the one already held, whatever is stored", () => {
    storage.set(KEY, JSON.stringify({ preset: "cols2", focusedPane: "b", tabPane: {}, activeTab: {}, commandPane: {} }));
    const held = defaultLayout();
    assert.equal(layoutOf({ p: held }, "p"), held);
  });

  it("is a fresh default where nothing is stored", () => {
    assert.deepEqual(layoutOf({}, "p"), defaultLayout());
  });
});

describe("reconciling every layout with its tabs", () => {
  it("answers the same record when nothing changed, whatever the lists' contents", () => {
    const tabs = { p: [tab("x"), tab("y")] };
    const reconciled = new WeakMap<ProjectLayout, LayoutTab[]>();
    const first = reconcileLayouts({ p: twoColumns() }, tabs, {}, reconciled);
    const again = reconcileLayouts(first, tabs, tabs, reconciled);
    assert.equal(again, first);
  });

  it("skips a project whose list is the one its layout was reconciled against, even with a pane empty", () => {
    const list = [tab("x")];
    const layout = twoColumns();
    const reconciled = new WeakMap<ProjectLayout, LayoutTab[]>([[layout, list]]);
    const current = { p: layout };
    assert.equal(reconcileLayouts(current, { p: list }, { p: list }, reconciled), current);
  });

  it("collapses the pane whose last tab closed, and leaves the other projects' layouts as they are", () => {
    const other = twoColumns();
    const before = [tab("x"), tab("y")];
    const after = [tab("x")];
    const reconciled = new WeakMap<ProjectLayout, LayoutTab[]>();
    const result = reconcileLayouts({ p: twoColumns(), q: other }, { p: after, q: before }, { p: before, q: before }, reconciled);
    assert.equal(result.p.preset, "single");
    assert.equal(result.q, other);
  });

  it("loads a project's layout at its first tabs, reconciled against them", () => {
    storage.set(KEY, JSON.stringify({ preset: "cols2", focusedPane: "a", tabPane: { s1: "a", s2: "b" }, activeTab: {}, commandPane: {} }));
    const result = reconcileLayouts({}, { p: [tab("s1", "s1"), tab("s2", "s2")] }, {}, new WeakMap());
    assert.equal(result.p.preset, "cols2");
    assert.deepEqual(result.p.tabPane, { s1: "a", s2: "b" });
  });

  it("remembers the list a layout was reconciled against, so the same push is skipped next time", () => {
    const list = [tab("x"), tab("y")];
    const reconciled = new WeakMap<ProjectLayout, LayoutTab[]>();
    const result = reconcileLayouts({}, { p: list }, {}, reconciled);
    assert.equal(reconciled.get(result.p), list);
  });
});

describe("a layout once its project has started", () => {
  it("collapses the panes that stayed empty", () => {
    const layout: ProjectLayout = { ...twoColumns(), tabPane: { x: "a" }, activeTab: { a: "x" } };
    const result = settleLayout({ p: layout }, "p", [tab("x")]);
    assert.equal(result.p.preset, "single");
  });

  it("is the same record where no pane is empty", () => {
    const current = { p: twoColumns() };
    assert.equal(settleLayout(current, "p", [tab("x"), tab("y")]), current);
  });

  it("holds nothing of a project it had nothing for, and never writes the loaded layout back", () => {
    const current: Record<string, ProjectLayout> = {};
    assert.equal(settleLayout(current, "p", undefined), current);
  });
});

describe("making a tab a pane's active one", () => {
  const tabs = [tab("x"), tab("y")];

  it("goes to the pane asked for", () => {
    // A second tab stays in `a`, so the move empties nothing.
    const layout: ProjectLayout = { ...twoColumns(), tabPane: { x: "a", z: "a", y: "b" } };
    const result = activateIn({ p: layout }, "p", "x", "b", [...tabs, tab("z")]);
    assert.equal(result.p.tabPane.x, "b");
    assert.equal(result.p.activeTab.b, "x");
    assert.equal(result.p.focusedPane, "b");
  });

  it("goes to the pane it lives in, without one asked for", () => {
    const result = activateIn({ p: twoColumns() }, "p", "y", undefined, tabs);
    assert.equal(result.p.tabPane.y, "b");
    assert.equal(result.p.focusedPane, "b");
  });

  it("goes to where it lives when the pane asked for is one the preset no longer has", () => {
    const result = activateIn({ p: twoColumns() }, "p", "y", "d", tabs);
    assert.equal(result.p.tabPane.y, "b");
    assert.equal(result.p.focusedPane, "b");
  });

  it("goes to the focused pane for a tab no pane holds yet", () => {
    const result = activateIn({ p: twoColumns() }, "p", "new", undefined, [...tabs, tab("new")]);
    assert.equal(result.p.tabPane.new, "a");
  });

  it("leaves the other projects' layouts as they are", () => {
    const other = twoColumns();
    const result = activateIn({ p: twoColumns(), q: other }, "p", "x", "b", tabs);
    assert.equal(result.q, other);
  });
});

describe("writing the layouts", () => {
  const tabs = { p: [tab("x", "s1"), tab("y", "s2")] };

  it("writes nothing for a project whose bootstrap has not finished", () => {
    const persistence = newLayoutPersistence();
    persistLayouts({ p: twoColumns() }, tabs, persistence);
    assert.equal(storage.has(KEY), false);
  });

  it("writes a settled project's layout under its sessions", () => {
    const persistence = newLayoutPersistence();
    persistence.settled.add("p");
    persistLayouts({ p: twoColumns() }, tabs, persistence);
    assert.deepEqual(written().tabPane, { s1: "a", s2: "b" });
    assert.equal(written().preset, "cols2");
  });

  it("writes only a settled project's, among several", () => {
    const persistence = newLayoutPersistence();
    persistence.settled.add("p");
    persistLayouts({ p: twoColumns(), q: twoColumns() }, { ...tabs, q: tabs.p }, persistence);
    assert.equal(storage.has(KEY), true);
    assert.equal(storage.has(layoutStorageKey("q", "layout")), false);
  });

  it("does not write again for the same layout and tab list", () => {
    const persistence = newLayoutPersistence();
    persistence.settled.add("p");
    const layouts = { p: twoColumns() };
    persistLayouts(layouts, tabs, persistence);
    storage.delete(KEY);
    persistLayouts(layouts, tabs, persistence);
    assert.equal(storage.has(KEY), false, "the same pair serializes the same");
  });

  it("does not write when a new list serializes to the same text, as a spinner tick does", () => {
    const persistence = newLayoutPersistence();
    persistence.settled.add("p");
    const layouts = { p: twoColumns() };
    persistLayouts(layouts, tabs, persistence);
    storage.delete(KEY);
    persistLayouts(layouts, { p: tabs.p.map((entry) => ({ ...entry })) }, persistence);
    assert.equal(storage.has(KEY), false);
  });

  it("writes again when a tab gets its session, which changes what is written", () => {
    const persistence = newLayoutPersistence();
    persistence.settled.add("p");
    const layouts = { p: twoColumns() };
    persistLayouts(layouts, { p: [tab("x", "s1"), tab("y")] }, persistence);
    assert.deepEqual(written().tabPane, { s1: "a" });
    persistLayouts(layouts, { p: [tab("x", "s1"), tab("y", "s2")] }, persistence);
    assert.deepEqual(written().tabPane, { s1: "a", s2: "b" });
  });

  it("forgets a removed project, so one added again under its key is written anew", () => {
    const persistence = newLayoutPersistence();
    persistence.settled.add("p");
    const layouts = { p: twoColumns() };
    persistLayouts(layouts, tabs, persistence);
    forgetPersistence(persistence, "p");
    assert.deepEqual(persistence, newLayoutPersistence());
    persistence.settled.add("p");
    storage.delete(KEY);
    persistLayouts(layouts, tabs, persistence);
    assert.equal(storage.has(KEY), true);
  });
});
