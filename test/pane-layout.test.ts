import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPreset,
  defaultLayout,
  loadLayout,
  normalizeLayout,
  serializeLayout,
  visibleTabIds
} from "../src/renderer/pane-layout";
import type { ProjectLayout } from "../src/renderer/pane-layout";
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
