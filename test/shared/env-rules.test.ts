import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { envNameKey } from "../../src/shared/env-rules";

/** shared/env-rules.ts: what a name kept in TET's environment may be. */

describe("a variable's name as a machine compares it", () => {
  it("is one key for any case where the machine ignores case", () => {
    assert.equal(envNameKey("Path", true), envNameKey("PATH", true));
  });

  it("is the name itself where case counts", () => {
    assert.notEqual(envNameKey("Path", false), envNameKey("PATH", false));
  });
});
