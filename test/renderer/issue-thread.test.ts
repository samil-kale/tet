import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueThread } from "../../src/renderer/editor/issue-thread";
import type { IssueEvent, IssueNote } from "../../src/shared/types/providers";

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
const note = (id: string, minute: number): IssueNote => ({ id, author: "mira", createdAt: at(minute), body: "Text" });
const labeled = (minute: number, name: string, actor = "mira"): IssueEvent => ({
  actor,
  createdAt: at(minute),
  kind: "labeled",
  label: name,
});

describe("an issue's thread", () => {
  it("lists comments and events as they happened, a comment before what it was made with", () => {
    const closed: IssueEvent = { actor: "mira", createdAt: at(5), kind: "closed" };
    const thread = issueThread([note("1", 5), note("2", 1)], [closed]);
    assert.deepEqual(thread, [{ note: note("2", 1) }, { note: note("1", 5) }, { event: closed }]);
  });

  it("gathers one actor's changes of labels and of assignees into a line each", () => {
    const thread = issueThread(
      [],
      [
        labeled(0, "bug"),
        labeled(1, "ui"),
        labeled(2, "bug"),
        { actor: "mira", createdAt: at(3), kind: "unlabeled", label: "old" },
        { actor: "mira", createdAt: at(4), kind: "assigned", login: "jonas" },
        { actor: "mira", createdAt: at(5), kind: "unassigned", login: "lena" },
      ],
    );
    assert.deepEqual(thread, [
      { event: { actor: "mira", createdAt: at(0), kind: "labels", added: ["bug", "ui"], removed: ["old"] } },
      { event: { actor: "mira", createdAt: at(4), kind: "assignees", assigned: ["jonas"], unassigned: ["lena"] } },
    ]);
  });

  it("gathers nothing past the window, across actors or across a comment", () => {
    const lines = (notes: IssueNote[], events: IssueEvent[]): number => issueThread(notes, events).length;
    assert.equal(lines([], [labeled(0, "a"), labeled(10, "b")]), 2);
    assert.equal(lines([], [labeled(0, "a"), labeled(1, "b", "jonas")]), 2);
    assert.equal(lines([note("1", 1)], [labeled(0, "a"), labeled(2, "b")]), 3);
  });
});
