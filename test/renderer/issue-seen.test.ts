import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUnread } from "../../src/renderer/editor/issue-seen";
import type { Issue, IssuesSeen } from "../../src/shared/types/providers";

const issue = (number: number, updatedAt: string): Issue =>
  ({ number, title: "t", updatedAt, createdAt: "2026-10-01T00:00:00Z", author: "mira", labels: [], avatars: {} }) as unknown as Issue;

const seen: IssuesSeen = { since: "2026-11-01T00:00:00Z", issues: { 3: "2026-11-05T10:00:00Z" } };

describe("an unread issue", () => {
  it("is one the tracker changed after its tab last showed it", () => {
    assert.equal(isUnread(issue(3, "2026-11-05T10:00:00Z"), seen), false, "as shown");
    assert.equal(isUnread(issue(3, "2026-11-06T09:00:00Z"), seen), true, "changed since");
    assert.equal(isUnread(issue(3, "2026-11-02T09:00:00Z"), seen), false, "its entry counts, not `since`");
  });

  it("is one never shown that the tracker created or changed after `since`", () => {
    assert.equal(isUnread(issue(9, "2026-11-02T00:00:00Z"), seen), true, "new or changed since");
    assert.equal(isUnread(issue(9, "2026-10-20T00:00:00Z"), seen), false, "older, so read");
  });

  it("compares times, not the trackers' spellings of them", () => {
    assert.equal(isUnread(issue(9, "2026-11-01T01:00:00+02:00"), seen), false, "an hour before `since`, in another zone");
    assert.equal(isUnread(issue(9, "2026-11-01T00:00:00.500Z"), seen), true, "with fractions of a second");
  });

  it("is none before the project's list was read", () => {
    assert.equal(isUnread(issue(9, "2026-11-09T00:00:00Z"), undefined), false);
  });
});
