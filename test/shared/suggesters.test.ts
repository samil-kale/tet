import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestersFor } from "../../src/shared/suggesters";

describe("suggestersFor", () => {
  it("keeps the saved order and switches, leaves out what is not installed and adds a new agent last", () => {
    const saved = [
      { agentId: "pi", model: "x", enabled: true },
      { agentId: "gone", model: "", enabled: true },
      { agentId: "claude", model: "", enabled: false },
    ];
    assert.deepEqual(suggestersFor(saved, ["claude", "codex", "pi"]), [
      { agentId: "pi", model: "x", enabled: true },
      { agentId: "claude", model: "", enabled: false },
      { agentId: "codex", model: "", enabled: true },
    ]);
  });

  it("is the installed agents in their own order, all on, where nothing was saved", () => {
    assert.deepEqual(suggestersFor([], ["claude", "codex"]), [
      { agentId: "claude", model: "", enabled: true },
      { agentId: "codex", model: "", enabled: true },
    ]);
  });
});
