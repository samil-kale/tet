import { isModifierHeld, modifierLabel } from "./platform";

/**
 * The window's shortcuts, all on combinations xterm never turns into bytes. See "The keyboard
 * belongs to the terminal" in AGENTS.md.
 *
 * For the next shortcut: `Ctrl+<letter>` is a control byte, `Ctrl+Shift+<letter>` sends nothing.
 * `Alt+1…9` is taken (readline's digit argument). `Ctrl+Tab`/`Ctrl+Shift+Tab` equal Tab/Shift+Tab —
 * the latter Claude Code's mode toggle. `Ctrl+,` and `Ctrl+Shift+.`/`Ctrl+Shift+,` send nothing.
 * None of these close a tab.
 */
type ShortcutId =
  | "settings"
  | "toggleGit"
  | "toggleFiles"
  | "needsAttention"
  | "nextTab"
  | "previousTab"
  | "newShellTab";

interface ShortcutDef {
  id: ShortcutId;
  description: string;
  shift: boolean;
  /** `event.key.toLowerCase()` to match. */
  key: string;
  /** Also matched: under Shift, `key` is layout-dependent (`Ctrl+Shift+.` is `:` on German). */
  code?: string;
  /** As shown to the user, unlowercased. */
  label: string;
}

const DEFS: ShortcutDef[] = [
  { id: "settings", description: "Open settings", shift: false, key: ",", label: "," },
  { id: "toggleGit", description: "Show or hide the repository", shift: true, key: "g", label: "G" },
  { id: "toggleFiles", description: "Show or hide the files", shift: true, key: "e", label: "E" },
  {
    id: "needsAttention",
    description: "Jump to the session that needs you",
    shift: true,
    key: "u",
    label: "U"
  },
  { id: "nextTab", description: "Next tab", shift: true, key: ".", code: "Period", label: "." },
  { id: "previousTab", description: "Previous tab", shift: true, key: ",", code: "Comma", label: "," },
  { id: "newShellTab", description: "New shell tab", shift: true, key: "t", label: "T" }
];

/**
 * A key whose `code` a shortcut names is matched by `code` alone: on French AZERTY the `Comma` key
 * reports `.` under Shift, which by `key` would be "next tab" and leave "previous tab" on no key.
 */
export function matchesShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  const def = DEFS.find((entry) => entry.id === id);
  // No shortcut takes Alt, and on Windows AltGr arrives as Ctrl+Alt: AltGr+Shift+Comma types "Ç"
  // on US International, which `code` alone would read as "previous tab".
  if (def === undefined || !isModifierHeld(event) || event.altKey || event.shiftKey !== def.shift) {
    return false;
  }
  if (DEFS.some((entry) => entry.shift === event.shiftKey && entry.code === event.code)) {
    return def.code === event.code;
  }
  return event.key.toLowerCase() === def.key;
}

export function shortcutLabel(id: ShortcutId): string {
  const def = DEFS.find((entry) => entry.id === id);
  if (!def) {
    return "";
  }
  const mod = modifierLabel();
  return def.shift ? `${mod}+Shift+${def.label}` : `${mod}+${def.label}`;
}

/** The settings dialog's Info tab lists these, in DEFS order. */
export const SHORTCUTS: { id: ShortcutId; description: string }[] = DEFS.map(({ id, description }) => ({
  id,
  description
}));
