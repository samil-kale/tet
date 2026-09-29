import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdEscape } from "../../src/renderer/ui/use-escape";

/** ui/: what the views share. */

describe("Escape over the window's dialogs", () => {
  it("closes only the last one opened, then the one below it", () => {
    // What the renderer's `document` does with a keydown, enough for the capture listener.
    const globals = globalThis as { document?: EventTarget };
    globals.document = new EventTarget();
    try {
      const closed: string[] = [];
      const escape = (): Event => Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
      const releaseSettings = holdEscape({ current: () => closed.push("settings") });
      const releaseCredential = holdEscape({ current: () => closed.push("credential") });
      globals.document.dispatchEvent(escape());
      assert.deepEqual(closed, ["credential"], "the credential dialog over the Settings");
      releaseCredential();
      globals.document.dispatchEvent(escape());
      assert.deepEqual(closed, ["credential", "settings"]);
      releaseSettings();
      globals.document.dispatchEvent(escape());
      assert.deepEqual(closed, ["credential", "settings"], "nothing left to close");
    } finally {
      delete globals.document;
    }
  });
});
