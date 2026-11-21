import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeIssueRows, type IssueRowItem } from "../../src/renderer/ui/use-issue-rows";
import type { Issue } from "../../src/shared/types/providers";

/** lanes/issues/use-issue-rows.ts: what the tracker adds or removes enters or leaves in place. */

const issue = (number: number): Issue => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  open: true,
  author: "mira",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  labels: [],
  avatars: {},
});

const row = (number: number, fields: Partial<IssueRowItem> = {}): IssueRowItem => ({
  issue: issue(number),
  entering: false,
  leaving: false,
  ...fields,
});

/** Each row as its number, `+` entering, `-` leaving. */
const shape = (rows: IssueRowItem[]): string[] =>
  rows.map(({ issue: { number }, entering, leaving }) => `${number}${entering ? "+" : ""}${leaving ? "-" : ""}`);

describe("mergeIssueRows", () => {
  it("enters an issue new to the list where the list has it", () => {
    assert.deepEqual(shape(mergeIssueRows([row(3), row(1)], [issue(4), issue(3), issue(1)])), ["4+", "3", "1"]);
  });

  it("keeps a removed issue leaving after the row it stood behind", () => {
    assert.deepEqual(shape(mergeIssueRows([row(4), row(3), row(2), row(1)], [issue(4), issue(1)])), ["4", "3-", "2-", "1"]);
  });

  it("keeps a removed first issue leaving at the top", () => {
    assert.deepEqual(shape(mergeIssueRows([row(2), row(1)], [issue(1)])), ["2-", "1"]);
  });

  it("keeps a row leaving through the next list, until it has gone", () => {
    const previous = [row(3), row(2, { leaving: true }), row(1)];
    assert.deepEqual(shape(mergeIssueRows(previous, [issue(5), issue(3), issue(1)])), ["5+", "3", "2-", "1"]);
  });

  it("unfolds a leaving issue that comes back from where it is, not entering anew", () => {
    assert.deepEqual(shape(mergeIssueRows([row(2, { leaving: true }), row(1)], [issue(2), issue(1)])), ["2", "1"]);
  });

  it("keeps an entering row entering through the next list", () => {
    assert.deepEqual(shape(mergeIssueRows([row(2, { entering: true }), row(1)], [issue(2), issue(1)])), ["2+", "1"]);
  });

  it("takes the issue as the new list has it", () => {
    const renamed = { ...issue(1), title: "Renamed" };
    assert.equal(mergeIssueRows([row(1)], [renamed])[0]?.issue.title, "Renamed");
  });
});
