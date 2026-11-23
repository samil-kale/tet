import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { around, BlockMarks, lineOfTop, topOfLine, type Mark } from "../../src/renderer/editor/block-marks";

/** editor/block-marks.ts: the Markdown preview's block positions behind the scroll sync. */

const marks: Mark[] = [
  { line: 0, top: 0 },
  { line: 4, top: 100 },
  { line: 10, top: 400 },
];

describe("a preview's block marks", () => {
  it("finds the marks around a position by halving, as a scan would", () => {
    const many = Array.from({ length: 1000 }, (_, index) => ({ line: index * 3, top: index * 50 }));
    for (const line of [-1, 0, 1, 3, 1500, 2997, 5000]) {
      const index = many.filter((mark) => mark.line <= line).length - 1;
      assert.deepEqual(
        around(many, (mark) => mark.line <= line),
        [many[index], many[index + 1]],
      );
    }
    assert.deepEqual(
      around([], () => true),
      [undefined, undefined],
    );
  });

  it("maps a source line to an offset in proportion between the blocks, and back", () => {
    assert.equal(topOfLine(marks, 2), 50);
    assert.equal(topOfLine(marks, 7), 250);
    assert.equal(topOfLine(marks, 12), 400, "past the last block");
    assert.equal(topOfLine(marks, -1), 0);
    assert.equal(lineOfTop(marks, 50), 2);
    assert.equal(lineOfTop(marks, 250), 7);
    assert.equal(lineOfTop(marks, 900), 10);
    assert.equal(lineOfTop([], 10), undefined);
    assert.equal(lineOfTop([{ line: 3, top: 20 }], 5), 0, "above the first block");
  });

  it("measures once until invalidated", () => {
    let measured = 0;
    const cache = new BlockMarks(() => {
      measured += 1;
      return marks;
    });
    cache.get();
    cache.get();
    assert.equal(measured, 1);
    cache.invalidate();
    cache.get();
    assert.equal(measured, 2);
  });
});
