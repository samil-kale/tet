import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  annotationAt,
  formatFeedback,
  MOUSE_TRACKING_OFF,
  mouseTrackingOn,
  rangeContains,
  relocateRange,
  rowSegments,
  textOfRange,
  touchesTracking,
  trackingAfter,
  type Annotation,
  type CellRange,
  type RangeSource,
} from "../../src/renderer/tabs/annotate-feedback";

/** tabs/annotate-feedback.ts: what the annotate mode keeps and says, apart from xterm. */

/** Rows of text, as xterm's buffer hands them out: `translateToString` over a column range. */
function rows(...lines: string[]): RangeSource {
  return {
    getLine: (row) =>
      lines[row] === undefined
        ? undefined
        : {
            translateToString: (trimRight = false, startColumn = 0, endColumn?: number) => {
              const text = lines[row].slice(startColumn, endColumn);
              return trimRight ? text.trimEnd() : text;
            },
          },
  };
}

function annotation(id: number, range: CellRange, partial: Partial<Annotation> = {}): Annotation {
  return { id, kind: "comment", text: "", range, buffer: "normal", ...partial };
}

describe("rowSegments", () => {
  it("is one segment on a single row", () => {
    assert.deepEqual(rowSegments({ startRow: 3, startCol: 2, endRow: 3, endCol: 7 }, 80), [{ row: 3, startCol: 2, endCol: 7 }]);
  });

  it("runs the first row to the edge, the middle rows whole and the last from the start", () => {
    assert.deepEqual(rowSegments({ startRow: 1, startCol: 5, endRow: 3, endCol: 4 }, 10), [
      { row: 1, startCol: 5, endCol: 10 },
      { row: 2, startCol: 0, endCol: 10 },
      { row: 3, startCol: 0, endCol: 4 },
    ]);
  });

  it("leaves out a row the range only touches", () => {
    assert.deepEqual(rowSegments({ startRow: 1, startCol: 10, endRow: 2, endCol: 0 }, 10), []);
  });
});

describe("rangeContains and annotationAt", () => {
  const range: CellRange = { startRow: 1, startCol: 5, endRow: 2, endCol: 3 };

  it("includes the start cell and excludes the end cell", () => {
    assert.equal(rangeContains(range, 1, 5), true);
    assert.equal(rangeContains(range, 1, 4), false);
    assert.equal(rangeContains(range, 2, 2), true);
    assert.equal(rangeContains(range, 2, 3), false);
  });

  it("takes every column of the rows between", () => {
    assert.equal(rangeContains({ ...range, endRow: 4 }, 3, 0), true);
    assert.equal(rangeContains(range, 0, 9), false);
    assert.equal(rangeContains(range, 3, 0), false);
  });

  it("finds the latest of the annotations covering a cell, and none elsewhere", () => {
    const first = annotation(1, range);
    const second = annotation(2, { startRow: 1, startCol: 6, endRow: 1, endCol: 8 });
    assert.equal(annotationAt([first, second], 1, 7)?.id, 2);
    assert.equal(annotationAt([first, second], 1, 5)?.id, 1);
    assert.equal(annotationAt([first, second], 5, 5), undefined);
  });
});

describe("textOfRange", () => {
  const source = rows("  1. Wrap uploadChunk in withRetry", "  2. Treat 429 as retryable   ", "  3. Add jitter");

  it("reads a column range of one row", () => {
    assert.equal(textOfRange(source, { startRow: 0, startCol: 5, endRow: 0, endCol: 16 }), "Wrap upload");
  });

  it("joins rows by a space and collapses whitespace", () => {
    assert.equal(textOfRange(source, { startRow: 0, startCol: 25, endRow: 2, endCol: 8 }), "withRetry 2. Treat 429 as retryable 3. Add");
  });

  it("reads a row that is not there as empty", () => {
    assert.equal(textOfRange(source, { startRow: 9, startCol: 0, endRow: 9, endCol: 5 }), "");
  });
});

describe("formatFeedback", () => {
  it("numbers the annotations in the order made, a comment after its quote", () => {
    const text = formatFeedback([
      annotation(7, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, { text: "3 attempts", comment: "Make it configurable." }),
      annotation(9, { startRow: 1, startCol: 0, endRow: 1, endCol: 1 }, { kind: "good", text: "fail fast" }),
      annotation(8, { startRow: 2, startCol: 0, endRow: 2, endCol: 1 }, { kind: "delete", text: "use axios" }),
    ]);
    assert.equal(
      text,
      [
        "Annotations on your output",
        "",
        '1 (comment) "3 attempts": Make it configurable.',
        '2 (looks good) "fail fast"',
        '3 (delete) "use axios"',
      ].join("\n"),
    );
  });
});

describe("mouse reporting", () => {
  it("turns the reporting modes off in one sequence and the other modes stay", () => {
    assert.equal(MOUSE_TRACKING_OFF, "\x1b[?9;1000;1002;1003l");
    assert.equal(touchesTracking([1006]), false);
    assert.equal(touchesTracking([1004, 1002]), true);
  });

  it("puts a mode back by its own sequence", () => {
    assert.equal(mouseTrackingOn("x10"), "\x1b[?9h");
    assert.equal(mouseTrackingOn("vt200"), "\x1b[?1000h");
    assert.equal(mouseTrackingOn("drag"), "\x1b[?1002h");
    assert.equal(mouseTrackingOn("any"), "\x1b[?1003h");
    assert.equal(mouseTrackingOn("none"), "");
  });

  it("follows what the program asks, a set naming the mode and a reset ending all", () => {
    assert.equal(trackingAfter("none", [1000], true), "vt200");
    assert.equal(trackingAfter("vt200", [1003, 1006], true), "any");
    assert.equal(trackingAfter("any", [1003], false), "none");
    assert.equal(trackingAfter("drag", [1004], true), "drag");
  });

  it("takes no reset of ours for the program's", () => {
    assert.equal(trackingAfter("vt200", [9, 1000, 1002, 1003], false), "vt200");
  });
});

describe("relocateRange", () => {
  const range: CellRange = { startRow: 2, startCol: 0, endRow: 2, endCol: 9 };

  it("finds a text that moved down or up, by the fewest rows", () => {
    const down = rows("a", "b", "c", "x", "fail fast", "y");
    assert.deepEqual(relocateRange(down, 6, range, "fail fast"), { startRow: 4, startCol: 0, endRow: 4, endCol: 9 });
    const up = rows("fail fast", "b", "c");
    assert.deepEqual(relocateRange(up, 3, range, "fail fast"), { startRow: 0, startCol: 0, endRow: 0, endCol: 9 });
  });

  it("moves a range of several rows as a whole", () => {
    const source = rows("x", "x", "one two", "three four", "x");
    const found = relocateRange(source, 5, { startRow: 0, startCol: 0, endRow: 1, endCol: 10 }, "one two three four");
    assert.deepEqual(found, { startRow: 2, startCol: 0, endRow: 3, endCol: 10 });
  });

  it("prefers the nearer of two places", () => {
    const source = rows("fail fast", "x", "x", "x", "fail fast", "x");
    assert.equal(relocateRange(source, 6, { startRow: 3, startCol: 0, endRow: 3, endCol: 9 }, "fail fast")?.startRow, 4);
  });

  it("finds nothing where the text is gone", () => {
    assert.equal(relocateRange(rows("a", "b", "c"), 3, range, "fail fast"), undefined);
  });
});
