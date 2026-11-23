import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scrollTopFor, windowRange } from "../../src/renderer/ui/use-windowed-rows";

/** ui/use-windowed-rows: which rows of a long list are drawn. */
describe("windowRange", () => {
  it("starts at the top with the viewport's rows and the overscan after them", () => {
    assert.deepEqual(windowRange(1000, 24, 0, 240, 5), { start: 0, end: 15 });
  });

  it("keeps the overscan before and after the first visible row", () => {
    assert.deepEqual(windowRange(1000, 24, 2400, 240, 5), { start: 95, end: 115 });
  });

  it("never leaves the list", () => {
    assert.deepEqual(windowRange(100, 24, 100000, 240, 5), { start: 94, end: 100 });
    assert.deepEqual(windowRange(3, 24, -50, 240, 5), { start: 0, end: 3 });
    assert.deepEqual(windowRange(0, 24, 0, 240, 5), { start: 0, end: 0 });
  });
});

describe("scrollTopFor", () => {
  it("leaves a row in view where it is", () => {
    assert.equal(scrollTopFor(5, 24, 100, 240), 100);
  });

  it("moves a row above the view to its top, and one below to the view's bottom", () => {
    assert.equal(scrollTopFor(2, 24, 100, 240), 48);
    assert.equal(scrollTopFor(30, 24, 100, 240), 30 * 24 + 24 - 240);
  });
});
