import type { Platform } from "./platform";

/**
 * The window's shortcuts, all on combinations xterm never turns into bytes. See "The keyboard
 * belongs to the terminal" in AGENTS.md. Here for both processes: the window matches them on its
 * own keys, main on a browser tab's page (browser/browser-tabs.ts), whose keys the window never sees.
 *
 * For the next shortcut: `Ctrl+<letter>` is a control byte, `Ctrl+Shift+<letter>` sends nothing.
 * `Alt+1…9` is taken (readline's digit argument). `Ctrl+Tab`/`Ctrl+Shift+Tab` equal Tab/Shift+Tab —
 * the latter Claude Code's mode toggle. `Ctrl+,` and `Ctrl+Shift+.`/`Ctrl+Shift+,` send nothing.
 * None of these close a tab.
 */
export type ShortcutId =
  "settings" | "toggleProjects" | "toggleGit" | "toggleFiles" | "jumpToWaiting" | "nextTab" | "previousTab" | "newShellTab";

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

export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
  { id: "settings", description: "Open settings", shift: false, key: ",", label: "," },
  { id: "toggleProjects", description: "Show or hide projects", shift: true, key: "p", label: "P" },
  { id: "toggleGit", description: "Show or hide git", shift: true, key: "g", label: "G" },
  { id: "toggleFiles", description: "Show or hide files", shift: true, key: "e", label: "E" },
  {
    id: "jumpToWaiting",
    description: "Jump to the waiting tab",
    shift: true,
    key: "u",
    label: "U",
  },
  { id: "nextTab", description: "Next tab", shift: true, key: ".", code: "Period", label: "." },
  { id: "previousTab", description: "Previous tab", shift: true, key: ",", code: "Comma", label: "," },
  { id: "newShellTab", description: "New shell tab", shift: true, key: "t", label: "T" },
];

/** A key press as both a DOM `KeyboardEvent` and electron's `Input` can say it. */
export interface ShortcutKey {
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * The shortcut a key press is, if any. A key whose `code` a shortcut names is matched by `code`
 * alone: on French AZERTY the `Comma` key reports `.` under Shift, which by `key` would be "next
 * tab" and leave "previous tab" on no key.
 */
export function shortcutOf(event: ShortcutKey, platform: Platform): ShortcutId | undefined {
  const modifierHeld = platform.modifierKey === "Meta" ? event.metaKey : event.ctrlKey;
  // No shortcut takes Alt, and on Windows AltGr arrives as Ctrl+Alt: AltGr+Shift+Comma types "Ç"
  // on US International, which `code` alone would read as "previous tab".
  if (!modifierHeld || event.altKey) {
    return undefined;
  }
  const candidates = SHORTCUT_DEFS.filter((def) => def.shift === event.shiftKey);
  return (candidates.find((def) => def.code === event.code) ?? candidates.find((def) => event.key.toLowerCase() === def.key))?.id;
}
