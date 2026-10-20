import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAC, WINDOWS } from "../../src/shared/platform";
import { shortcutOf, type ShortcutKey } from "../../src/renderer/shortcuts";

/** A key pressed with the platform's modifier, as a DOM event and electron's input both say it. */
const press = (key: string, code: string, held: Partial<ShortcutKey> = {}): ShortcutKey => ({
  key,
  code,
  shiftKey: false,
  altKey: false,
  ctrlKey: true,
  metaKey: false,
  ...held,
});

describe("shortcutOf", () => {
  it("matches by key, and by code where a shortcut names one", () => {
    assert.equal(shortcutOf(press("!", "Digit1", { shiftKey: true }), WINDOWS), "toggleProjects");
    // German: Ctrl+Shift+. reports ":".
    assert.equal(shortcutOf(press(":", "Period", { shiftKey: true }), WINDOWS), "nextTab");
    // French AZERTY: the Comma key reports "." under Shift, which is still "previous tab".
    assert.equal(shortcutOf(press(".", "Comma", { shiftKey: true }), WINDOWS), "previousTab");
    // Digits sit under Shift on AZERTY and report a symbol elsewhere: the code decides.
    assert.equal(shortcutOf(press("%", "Digit5", { shiftKey: true }), WINDOWS), "settings");
    assert.equal(shortcutOf(press("5", "Digit5", { shiftKey: true }), WINDOWS), "settings");
  });

  it("takes only the platform's modifier, never Alt", () => {
    assert.equal(shortcutOf(press("!", "Digit1", { shiftKey: true }), MAC), undefined, "Ctrl on a Mac");
    assert.equal(shortcutOf(press("!", "Digit1", { shiftKey: true, ctrlKey: false, metaKey: true }), MAC), "toggleProjects");
    // AltGr arrives as Ctrl+Alt on Windows.
    assert.equal(shortcutOf(press("Ç", "Comma", { shiftKey: true, altKey: true }), WINDOWS), undefined);
    assert.equal(shortcutOf(press("a", "KeyA"), WINDOWS), undefined);
  });
});
