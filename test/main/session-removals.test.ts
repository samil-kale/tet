import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionRemovals } from "../../src/main/terminals/session-removals";
import { deferred } from "../helpers";

/** session-removals.ts: which sessions are being deleted, while their deletion runs. */

describe("the sessions being deleted", () => {
  it("count one from before its process has ended until its deletion settled", async () => {
    const removals = new SessionRemovals();
    const stopped = deferred();
    const seen: string[] = [];
    const removing = removals.during("s1", stopped.promise, async () => {
      seen.push(`remove while counted: ${removals.has("s1")}`);
      return "removed";
    });
    await Promise.resolve();
    assert.deepEqual(removals.all(), ["s1"], "counted while its process still stops");
    assert.deepEqual(seen, [], "nothing removed before the process ended");
    stopped.resolve();
    assert.equal(await removing, "removed");
    assert.deepEqual(seen, ["remove while counted: true"]);
    assert.deepEqual(removals.all(), []);
  });

  it("stop counting one whose deletion was refused", async () => {
    const removals = new SessionRemovals();
    await assert.rejects(
      removals.during("s1", undefined, async () => {
        throw new Error("refused");
      }),
      /refused/,
    );
    assert.equal(removals.has("s1"), false);
  });
});
