import { SHORTCUT_DEFS, shortcutOf, type ShortcutId } from "../shared/shortcuts";
import { PLATFORM } from "./platform";

export type { ShortcutId } from "../shared/shortcuts";

/** The window's shortcut a key press is (src/shared/shortcuts.ts), if any. */
export function shortcutOfEvent(event: KeyboardEvent): ShortcutId | undefined {
  return shortcutOf(event, PLATFORM);
}

export function shortcutLabel(id: ShortcutId): string {
  const def = SHORTCUT_DEFS.find((entry) => entry.id === id);
  if (!def) {
    return "";
  }
  const mod = PLATFORM.modifierLabel;
  return def.shift ? `${mod}+Shift+${def.label}` : `${mod}+${def.label}`;
}

/** The settings dialog's Info tab lists these, in SHORTCUT_DEFS order. */
export const SHORTCUTS: { id: ShortcutId; description: string }[] = SHORTCUT_DEFS.map(({ id, description }) => ({
  id,
  description,
}));
