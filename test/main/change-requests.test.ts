import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareRound, probeKey } from "../../src/main/change-requests/watch";
import type { ChangeRequestRow } from "../../src/shared/types/providers";

/** watch.ts's rounds: what one round tells of the open change requests against what the last kept. */

const VIEWER = "me";

/** An open change request of `author`, ready unless `draft`. */
function row(number: number, author: string, extra: Partial<ChangeRequestRow> = {}): ChangeRequestRow {
  return {
    number,
    title: `request ${number}`,
    url: `https://example.com/${number}`,
    open: true,
    author,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    labels: [],
    avatars: {},
    state: "open",
    draft: false,
    ...extra,
  };
}

/** The numbers of what a round told. */
function told(rows: ChangeRequestRow[]): number[] {
  return rows.map((entry) => entry.number);
}

describe("a round of the change request watch", () => {
  it("only keeps what it read on its first round", () => {
    const { kept, opened, failed } = compareRound(undefined, [row(1, "anna"), row(2, VIEWER, { checks: "failed", headSha: "a" })], VIEWER);
    assert.deepEqual(opened, []);
    assert.deepEqual(failed, []);
    assert.deepEqual(
      [...kept],
      [
        [1, { draft: false, failedHead: undefined }],
        [2, { draft: false, failedHead: "a" }],
      ],
    );
  });

  it("tells one someone else opened, or made ready, but not the viewer's own", () => {
    const { kept } = compareRound(undefined, [row(1, "anna", { draft: true }), row(2, "anna")], VIEWER);
    const { opened } = compareRound(
      kept,
      [row(1, "anna"), row(2, "anna"), row(3, "anna"), row(4, VIEWER), row(5, "dan", { draft: true })],
      VIEWER,
    );
    assert.deepEqual(told(opened), [1, 3], "1 made ready, 3 new; 2 was there, 4 is the viewer's, 5 a draft");
  });

  it("tells the viewer's own whose checks failed, once for each head commit", () => {
    const first = compareRound(
      undefined,
      [row(1, VIEWER, { checks: "running", headSha: "a" }), row(2, "anna", { checks: "failed", headSha: "x" })],
      VIEWER,
    );
    const second = compareRound(
      first.kept,
      [row(1, VIEWER, { checks: "failed", headSha: "a" }), row(2, "anna", { checks: "failed", headSha: "y" })],
      VIEWER,
    );
    assert.deepEqual(told(second.failed), [1], "2 is someone else's");
    const third = compareRound(second.kept, [row(1, VIEWER, { checks: "failed", headSha: "a" })], VIEWER);
    assert.deepEqual(told(third.failed), [], "told for this head already");
    const fourth = compareRound(third.kept, [row(1, VIEWER, { checks: "passed", headSha: "b" })], VIEWER);
    assert.deepEqual(told(fourth.failed), []);
    const fifth = compareRound(fourth.kept, [row(1, VIEWER, { checks: "failed", headSha: "b" })], VIEWER);
    assert.deepEqual(told(fifth.failed), [1], "a new head failed");
  });

  it("tells no failure of a head it cannot name", () => {
    const { kept } = compareRound(undefined, [row(1, VIEWER)], VIEWER);
    const { failed } = compareRound(kept, [row(1, VIEWER, { checks: "failed" })], VIEWER);
    assert.deepEqual(failed, []);
  });
});

describe("watch.ts's cheap probe", () => {
  it("tells a change of the list, of its newest update or of its checks by the probe's key", () => {
    const base = { total: 2, updatedAt: "2026-01-01T00:00:00Z", checks: "1:passed" };
    assert.equal(probeKey(base), probeKey({ ...base }));
    assert.notEqual(probeKey(base), probeKey({ ...base, total: 3 }));
    assert.notEqual(probeKey(base), probeKey({ ...base, updatedAt: "2026-01-02T00:00:00Z" }));
    assert.notEqual(probeKey(base), probeKey({ ...base, checks: "1:failed" }));
    assert.notEqual(probeKey({ total: 0, checks: "" }), probeKey({ total: 0, updatedAt: "x", checks: "" }));
  });
});
