import { KeyCodeUtils } from "monaco-editor/base/common/keyCodes.js";
import type { Monaco } from "./editor";
import { KEYBINDING_PRESETS } from "./keybinding-presets";

/**
 * tet's own commands, layered under the chosen preset (`keybinding-presets.ts`). No chords, no
 * command that depends on a language provider, no format.
 */
const DEFAULT_KEYBINDINGS: Record<string, string> = {
  "ctrl+s": "tet.save",
  "ctrl+shift+v": "tet.markdownPreview"
};

/**
 * "ctrl+shift+s" as monaco's keybinding number; undefined for anything unknown. The key after the
 * last `+` is read the way VS Code reads keybindings.json (`KeyCodeUtils`, not a public API).
 */
export function parseKeyCombo(monaco: Monaco, combo: string): number | undefined {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const keyCode = KeyCodeUtils.fromUserSettings(parts[parts.length - 1]);
  if (!keyCode) {
    return undefined;
  }
  let mods = 0;
  for (const modifier of parts.slice(0, -1)) {
    if (modifier === "ctrl" || modifier === "cmd" || modifier === "meta") {
      mods |= monaco.KeyMod.CtrlCmd;
    } else if (modifier === "shift") {
      mods |= monaco.KeyMod.Shift;
    } else if (modifier === "alt" || modifier === "option") {
      mods |= monaco.KeyMod.Alt;
    } else {
      return undefined;
    }
  }
  return mods | keyCode;
}

/** The preset's bindings over tet's defaults; an unknown id yields the defaults. */
export function resolveKeybindings(presetId: string): Record<string, string> {
  const preset = KEYBINDING_PRESETS.find((entry) => entry.id === presetId);
  return { ...DEFAULT_KEYBINDINGS, ...preset?.bindings };
}
