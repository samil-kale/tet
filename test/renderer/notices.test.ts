import * as assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { keepGlobals } from "../helpers";
import { clearNotices, closeNotice, listNotices, notify, removeStaleNotices } from "../../src/renderer/ui/Notices";
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
const idOf = (message: string): number => listNotices().find((notice) => notice.message === message)?.id ?? -1;
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
afterEach(() => clearNotices());
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

describe("closing a notice", () => {
  it("marks the tab's finished turn seen, unless another finished notice of it is listed", () => {
    turnNotice("one", "a", "finished");
    turnNotice("two", "a", "finished");
    closeNotice(idOf("one"));
    assert.deepEqual(seen, [], "the other one still stands");
    closeNotice(idOf("two"));
    assert.deepEqual(seen, ["a"]);
  });

  it("leaves a question's mark standing: it goes with its answer", () => {
    turnNotice("question", "a", "waiting");
    closeNotice(idOf("question"));
    assert.deepEqual(seen, []);
  });
});

describe("clearing the notices", () => {
  it("marks the finished turns seen, never a question, and empties the list", () => {
    turnNotice("done", "a", "finished");
    turnNotice("question", "b", "waiting");
    notify("info", "plain", { toast: false });
    clearNotices();
    assert.deepEqual(seen, ["a"]);
    assert.deepEqual(listNotices(), []);
  });
});
