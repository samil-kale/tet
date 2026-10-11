import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jumpTarget, markedTabs, nextWorking, NO_IDS, refMarks } from "../../src/renderer/tabs/tab-marks";
import type { TabDescriptor } from "../../src/shared/types/terminals";

/** tabs/tab-marks.ts: which tabs a project row and the tab strip mark, decided against the screen. */

function tab(tabId: string, fields: Partial<TabDescriptor> = {}): TabDescriptor {
  return { tabId, agentId: "claude", title: "", status: "running", ...fields };
}

const ids = (tabs: TabDescriptor[]): string[] => tabs.map((entry) => entry.tabId);

describe("the marked tabs", () => {
  it("lists the finished ones oldest first, and leaves out those without the mark", () => {
    const tabs = [tab("new", { finishedAt: 30 }), tab("none"), tab("old", { finishedAt: 10 }), tab("mid", { finishedAt: 20 })];
    assert.deepEqual(ids(markedTabs(tabs, "finishedAt", NO_IDS)), ["old", "mid", "new"]);
  });

  it("leaves out a tab on screen, which was never out of sight", () => {
    const tabs = [tab("seen", { finishedAt: 10 }), tab("hidden", { finishedAt: 20 })];
    assert.deepEqual(ids(markedTabs(tabs, "finishedAt", ["seen"])), ["hidden"]);
    assert.deepEqual(ids(markedTabs([tab("q", { waitingAt: 5 })], "waitingAt", ["q"])), []);
  });

  it("keeps the two marks apart", () => {
    const tabs = [tab("done", { finishedAt: 10 }), tab("asks", { waitingAt: 20 })];
    assert.deepEqual(ids(markedTabs(tabs, "finishedAt", NO_IDS)), ["done"]);
    assert.deepEqual(ids(markedTabs(tabs, "waitingAt", NO_IDS)), ["asks"]);
  });

  it("does not reorder the tabs it is given", () => {
    const tabs = [tab("b", { finishedAt: 20 }), tab("a", { finishedAt: 10 })];
    markedTabs(tabs, "finishedAt", NO_IDS);
    assert.deepEqual(ids(tabs), ["b", "a"]);
  });
});

describe("a repository's marks", () => {
  it("counts a tab on screen as working, but never one waiting on a question", () => {
    assert.equal(refMarks([tab("a", { inTurn: true })], ["a"], undefined).working, true);
    assert.equal(refMarks([tab("a", { inTurn: true, waitingAt: 5 })], NO_IDS, undefined).working, false);
    assert.equal(refMarks([tab("a")], NO_IDS, undefined).working, false);
  });

  it("lists the starting tabs, on screen or not", () => {
    const marks = refMarks([tab("a", { starting: true }), tab("b"), tab("c", { starting: true })], ["a"], undefined);
    assert.deepEqual(marks.starting, ["a", "c"]);
  });

  it("hides a question while its tab is on screen, and shows it again once it is not", () => {
    const tabs = [tab("a", { waitingAt: 5 })];
    assert.deepEqual(refMarks(tabs, ["a"], undefined).waiting, []);
    assert.deepEqual(refMarks(tabs, NO_IDS, undefined).waiting, ["a"]);
  });

  it("hands the shared empty list to a project with no marks", () => {
    const marks = refMarks([tab("a")], NO_IDS, undefined);
    assert.equal(marks.finished, NO_IDS);
    assert.equal(marks.waiting, NO_IDS);
    assert.equal(marks.starting, NO_IDS);
  });

  it("keeps the previous lists where nothing changed, so a pane's props stay identical", () => {
    const tabs = [tab("a", { finishedAt: 10 }), tab("b", { waitingAt: 20 }), tab("c", { starting: true })];
    const first = refMarks(tabs, NO_IDS, undefined);
    const again = refMarks(
      tabs.map((entry) => ({ ...entry })),
      NO_IDS,
      first,
    );
    assert.equal(again.finished, first.finished);
    assert.equal(again.waiting, first.waiting);
    assert.equal(again.starting, first.starting);
    const changed = refMarks([...tabs, tab("d", { finishedAt: 30 })], NO_IDS, first);
    assert.notEqual(changed.finished, first.finished);
    assert.equal(changed.waiting, first.waiting);
  });
});

describe("stepping through the working tabs", () => {
  const tabs = [
    tab("a", { inTurn: true }),
    tab("idle"),
    tab("b", { inTurn: true }),
    tab("asks", { inTurn: true, waitingAt: 5 }),
    tab("c", { inTurn: true }),
  ];

  it("starts at the first, then goes one per press and wraps round", () => {
    assert.equal(nextWorking(tabs, undefined)?.tabId, "a");
    assert.equal(nextWorking(tabs, "a")?.tabId, "b");
    assert.equal(nextWorking(tabs, "b")?.tabId, "c");
    assert.equal(nextWorking(tabs, "c")?.tabId, "a");
  });

  it("starts over at the first when the tab shown last stopped, was closed or waits on a question", () => {
    assert.equal(nextWorking(tabs, "idle")?.tabId, "a");
    assert.equal(nextWorking(tabs, "gone")?.tabId, "a");
    assert.equal(nextWorking(tabs, "asks")?.tabId, "a");
  });

  it("stays on the only working tab", () => {
    assert.equal(nextWorking([tab("a", { inTurn: true })], "a")?.tabId, "a");
  });

  it("finds nothing where nothing works", () => {
    assert.equal(nextWorking([tab("a"), tab("b", { inTurn: true, waitingAt: 1 })], undefined), undefined);
    assert.equal(nextWorking([], "a"), undefined);
  });
});

describe("the jump to what is waiting", () => {
  const none = (): readonly string[] => NO_IDS;

  it("takes the longest-waiting question of any project before an older finished turn", () => {
    const tabs = {
      one: [tab("done", { finishedAt: 1 }), tab("asksLate", { waitingAt: 50 })],
      two: [tab("asksEarly", { waitingAt: 20 })],
    };
    assert.deepEqual(jumpTarget(tabs, none), { refKey: "two", tab: tabs.two[0] });
  });

  it("takes the oldest finished turn when nothing waits, across projects", () => {
    const tabs = { one: [tab("late", { finishedAt: 30 })], two: [tab("early", { finishedAt: 10 })] };
    assert.deepEqual(jumpTarget(tabs, none), { refKey: "two", tab: tabs.two[0] });
  });

  it("skips what is on screen, per project", () => {
    const tabs = { one: [tab("a", { waitingAt: 10 })], two: [tab("b", { waitingAt: 20 })] };
    assert.equal(jumpTarget(tabs, (refKey) => (refKey === "one" ? ["a"] : NO_IDS))?.tab.tabId, "b");
  });

  it("finds nothing where nothing is marked", () => {
    assert.equal(jumpTarget({ one: [tab("a", { inTurn: true })] }, none), undefined);
    assert.equal(jumpTarget({}, none), undefined);
  });
});
