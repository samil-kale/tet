import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { onRefClosed, refClosed } from "../../src/renderer/ref-lifetime";

/** ref-lifetime.ts: what is held per repository or worktree hears it close. */

describe("a repository or worktree closing", () => {
  it("reaches everything listening, with which one it was", () => {
    const heard: string[] = [];
    const stops = [onRefClosed((ref) => heard.push(`first ${ref.projectId}`)), onRefClosed((ref) => heard.push(`second ${ref.worktree}`))];
    refClosed({ projectId: "p", worktree: "k1" });
    assert.deepEqual(heard, ["first p", "second k1"]);
    stops.forEach((stop) => stop());
  });

  it("reaches nothing that stopped listening", () => {
    const heard: string[] = [];
    const stop = onRefClosed((ref) => heard.push(ref.projectId));
    stop();
    refClosed({ projectId: "p" });
    assert.deepEqual(heard, []);
  });

  it("still reaches the rest where one stops listening as it hears", () => {
    const heard: string[] = [];
    const stop = onRefClosed(() => {
      heard.push("first");
      stop();
    });
    const other = onRefClosed(() => heard.push("second"));
    refClosed({ projectId: "p" });
    assert.deepEqual(heard, ["first", "second"]);
    other();
  });
});
