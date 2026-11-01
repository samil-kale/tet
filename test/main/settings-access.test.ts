import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { settingsAccessOf } from "../../src/main/settings-access";
import { SettingsStore } from "../../src/main/store/settings";
import { currentTheme } from "../../src/main/store/theme";
import { resolveTheme, THEMES, themeKey } from "../../src/shared/themes";
import type { ThemeDefinition } from "../../src/shared/themes";
import { tempDir } from "../helpers";

/** settings-access.ts: a settings change, handed on to what shows or reads it. */

/** The access over a window showing `shown` (none: no window yet), and what it handed on. */
function access(shown: (settings: SettingsStore) => ThemeDefinition | undefined = currentTheme) {
  const settings = new SettingsStore(tempDir("tet-settings-access-"));
  const calls: string[] = [];
  let onScreen = shown(settings);
  const settingsAccess = settingsAccessOf({
    settings,
    window: {
      shownTheme: () => onScreen,
      showTheme: (theme) => {
        onScreen = theme;
        calls.push(`shown ${theme.id}`);
      },
    },
    tabManagers: {
      themeChanged: () => calls.push("theme"),
      idleReminderChanged: () => calls.push("idle reminder"),
    },
    repositories: { announceFilesChanged: () => calls.push("files") },
  });
  return { settings, settingsAccess, calls };
}

describe("a settings change", () => {
  it("is stored and read back", () => {
    const { settings, settingsAccess } = access();
    settingsAccess.patch({ notifications: { finished: false, waiting: true, idleReminder: true } });
    assert.equal(settings.get().notifications.finished, false);
    assert.equal(settingsAccess.get().notifications.finished, false);
  });

  it("reaches the tabs only where it changes the idle reminder", () => {
    const { settingsAccess, calls } = access();
    settingsAccess.patch({ files: {} });
    assert.equal(calls.includes("idle reminder"), false);
    settingsAccess.patch({ notifications: { finished: true, waiting: true, idleReminder: true } });
    assert.equal(calls.includes("idle reminder"), true);
  });

  it("reaches the Explorer only where it changes what lists", () => {
    const { settingsAccess, calls } = access();
    settingsAccess.patch({ notifications: { finished: true, waiting: true, idleReminder: false } });
    assert.equal(calls.includes("files"), false);
    settingsAccess.patch({ files: { compactFolders: true } });
    assert.equal(calls.includes("files"), true);
  });

  it("with no window yet applies no theme, and asks no restart", () => {
    const { settingsAccess, calls } = access(() => undefined);
    assert.equal(settingsAccess.patch({ files: {} }), false);
    assert.equal(
      calls.some((call) => call.startsWith("shown")),
      false,
    );
  });

  it("within the kind on screen shows the theme and hands it to the agents, without a restart", () => {
    const { settings, settingsAccess, calls } = access();
    const { kind, id } = currentTheme(settings);
    const other = THEMES.find((theme) => theme.kind === kind && theme.id !== id);
    assert.ok(other, "another theme of that kind");
    assert.equal(settingsAccess.patch({ appearance: { [themeKey(kind)]: other.id } }), false);
    assert.deepEqual(calls, [`shown ${other.id}`, "theme"]);
  });

  it("to the other kind asks a restart, and hands the agents nothing until then", () => {
    const { settingsAccess, calls } = access((store) => resolveTheme(undefined, currentTheme(store).kind === "dark" ? "light" : "dark"));
    assert.equal(settingsAccess.patch({ files: {} }), true);
    assert.equal(calls.includes("theme"), false);
  });
});
