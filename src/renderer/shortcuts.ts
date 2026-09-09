import { isMac, isModifierHeld } from "./platform";

/**
 * The window's own shortcuts, all of them on combinations xterm's `Keyboard.ts` never turns into
 * bytes (verified against the installed `@xterm/xterm`). See "The keyboard belongs to the
 * terminal" in CLAUDE.md.
 *
 * What that reading found, for the next shortcut: `evaluateKeyboardEvent`'s ctrl branch requires
 * `!shiftKey`, so `Ctrl+<letter>` is the agent's control byte (`Ctrl+G` is `\x07`) but
 * `Ctrl+Shift+<letter>` falls through every branch and sends nothing. `Alt+1…9` is out (`ESC 1`,
 * readline's digit argument), so is `Ctrl+Tab`/`Ctrl+Shift+Tab`: keyCode 9's case never looks at
 * `ctrlKey`, so both are byte-identical to plain Tab/Shift+Tab, and the latter is Claude Code's
 * own mode toggle. `Ctrl+,` and `Ctrl+Shift+.`/`Ctrl+Shift+,` appear in no branch, modified or
 * not. None of these close a tab.
 */
export type ShortcutId = "settings" | "toggleGit" | "needsAttention" | "nextTab" | "previousTab" | "newShellTab";

interface ShortcutDef {
  id: ShortcutId;
  description: string;
  shift: boolean;
  /** `event.key.toLowerCase()` to match. */
  key: string;
  /**
   * `event.code` to match as well: with Shift held, `key` is the shifted character, layout
   * dependent for punctuation (`Ctrl+Shift+.` reports `:` on a German keyboard).
   */
  code?: string;
  /** The key as shown to the user, unlowercased. */
  label: string;
}

const DEFS: ShortcutDef[] = [
  { id: "settings", description: "Open settings", shift: false, key: ",", label: "," },
  { id: "toggleGit", description: "Show or hide the repository", shift: true, key: "g", label: "G" },
  {
    id: "needsAttention",
    description: "Jump to the session that needs you — a question first, then one that finished out of sight",
    shift: true,
    key: "u",
    label: "U"
  },
  { id: "nextTab", description: "Next tab", shift: true, key: ".", code: "Period", label: "." },
  { id: "previousTab", description: "Previous tab", shift: true, key: ",", code: "Comma", label: "," },
  { id: "newShellTab", description: "New shell tab", shift: true, key: "t", label: "T" }
];

export function matchesShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  const def = DEFS.find((entry) => entry.id === id);
  return (
    def !== undefined &&
    isModifierHeld(event) &&
    event.shiftKey === def.shift &&
    (event.key.toLowerCase() === def.key || (def.code !== undefined && event.code === def.code))
  );
}

export function shortcutLabel(id: ShortcutId): string {
  const def = DEFS.find((entry) => entry.id === id);
  if (!def) {
    return "";
  }
  const mod = isMac() ? "⌘" : "Ctrl";
  return def.shift ? `${mod}+Shift+${def.label}` : `${mod}+${def.label}`;
}

/** What the settings dialog's Shortcuts tab lists, in the order defined above. */
export const SHORTCUTS: { id: ShortcutId; description: string }[] = DEFS.map(({ id, description }) => ({
  id,
  description
}));
