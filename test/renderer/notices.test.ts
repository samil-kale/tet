import * as assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { keepGlobals } from "../helpers";
import {
  centerOrder,
  clearNotices,
  listNotices,
  notify,
  removable,
  removeStaleNotices,
  syncWorkingNotices,
} from "../../src/renderer/ui/Notices";
import { projectRef, refKeyOf } from "../../src/shared/types/project";
import type { NoticeMark } from "../../src/shared/types/app";
import type { TabDescriptor } from "../../src/shared/types/terminals";

/** ui/Notices.tsx: a turn's notice follows its tab's mark on the project row. */

const ref = projectRef("p1");
const refKey = refKeyOf(ref);
/** Longer than the notification center's leaving transition. */
const LEFT_MS = 300;

function tab(tabId: string, fields: Partial<TabDescriptor> = {}): TabDescriptor {
  return { tabId, agentId: "claude", title: "", status: "running", ...fields };
}

const later = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, LEFT_MS));
const messages = (): string[] => listNotices().map((notice) => notice.message);
const turnNotice = (message: string, tabId: string, mark: NoticeMark): void =>
  notify("info", message, { toast: false, target: { ref, tabId }, mark });

/** The tabs the window was told were seen. */
let seen: string[];

beforeEach(() => {
  seen = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { tet: { app: { reportNotice: () => undefined }, tabs: { seen: (_ref: unknown, tabId: string) => seen.push(tabId) } } },
  });
});
afterEach(async () => {
  // What has a mark goes with its tabs; the rest is cleared.
  removeStaleNotices({});
  clearNotices();
  await later();
});
keepGlobals("window");

describe("a turn's notice", () => {
  it("goes once its tab's mark is gone, and stays while it stands", async () => {
    turnNotice("done", "a", "finished");
    turnNotice("question", "b", "waiting");
    notify("info", "plain", { toast: false });
    removeStaleNotices({ [refKey]: [tab("a", { finishedAt: 1 }), tab("b", { waitingAt: 2 })] });
    await later();
    assert.deepEqual(messages(), ["done", "question", "plain"]);

    removeStaleNotices({ [refKey]: [tab("a"), tab("b", { waitingAt: 2 })] });
    await later();
    assert.deepEqual(messages(), ["question", "plain"], "the finished mark was seen");

    removeStaleNotices({ [refKey]: [tab("a"), tab("b")] });
    await later();
    assert.deepEqual(messages(), ["plain"], "the question was answered; a notice without a mark stays");
  });

  it("goes when its tab is closed", async () => {
    turnNotice("question", "a", "waiting");
    removeStaleNotices({ [refKey]: [] });
    await later();
    assert.deepEqual(messages(), []);
  });

  it("leaves on its own, the last one taking the whole notification center along", () => {
    turnNotice("first", "a", "finished");
    turnNotice("second", "b", "finished");
    removeStaleNotices({ [refKey]: [tab("a"), tab("b", { finishedAt: 1 })] });
    assert.equal(listNotices()[0].leaving, "item");
    assert.equal(listNotices()[1].leaving, undefined);
    removeStaleNotices({ [refKey]: [tab("a"), tab("b")] });
    assert.equal(listNotices()[1].leaving, "center");
  });
});

describe("a notice with a mark", () => {
  it("cannot be removed, and clearing the notices leaves it with its tab's mark", () => {
    turnNotice("done", "a", "finished");
    turnNotice("question", "b", "waiting");
    notify("info", "plain", { toast: false });
    assert.deepEqual(listNotices().map(removable), [false, false, true]);
    clearNotices();
    assert.deepEqual(messages(), ["done", "question"]);
    assert.deepEqual(seen, []);
  });

  it("is listed above the others, in the order of the status bar's marks", () => {
    turnNotice("done", "a", "finished");
    notify("info", "plain", { toast: false });
    turnNotice("working", "b", "working");
    turnNotice("question", "c", "waiting");
    assert.deepEqual(
      centerOrder(listNotices()).map((notice) => notice.message),
      ["working", "question", "done", "plain"],
    );
  });
});

describe("the working sessions' notices", () => {
  it("are listed once each, renamed in place, and end with their tab's spinner", async () => {
    const working = (tabId: string, message: string) => ({ target: { ref, tabId }, title: "Working [Agent]", message });
    syncWorkingNotices([working("a", "one"), working("b", "two")]);
    syncWorkingNotices([working("a", "one renamed"), working("b", "two")]);
    assert.deepEqual(messages(), ["one renamed", "two"]);
    assert.equal(listNotices()[0].toast, false);

    removeStaleNotices({ [refKey]: [tab("a", { inTurn: true }), tab("b")] });
    await later();
    assert.deepEqual(messages(), ["one renamed"], "b's turn ended");

    removeStaleNotices({ [refKey]: [tab("a", { inTurn: true, waitingAt: 1 })] });
    await later();
    assert.deepEqual(messages(), [], "a stopped on a question: it does not work");
  });
});
