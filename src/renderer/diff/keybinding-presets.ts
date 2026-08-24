export interface KeybindingPreset {
  id: string;
  label: string;
  bindings: Record<string, string>;
}

/**
 * A curated keymap, one per popular editor/IDE — in-code data the settings dialog's preset
 * picker only ever selects from, never writes anywhere; `resolveKeybindings` (keybindings.ts)
 * layers the chosen one's bindings over this editor's own defaults, entirely in memory. Each is
 * trimmed from that editor's own well-known VS Code keymap extension down to the commands this
 * editor's reduced contribution set actually registers (see monaco-core.ts): line
 * comment/delete/copy/move, multi-cursor, fold/unfold, find/replace. Left out for all of them:
 * workbench-level commands (there is no explorer, no editor groups, no command palette here),
 * provider-dependent ones (format, rename, organize imports — no LSP), and chord bindings
 * ("ctrl+k ctrl+b") — `parseKeyCombo` only understands a single combo per command.
 * A binding identical to this editor's own default is left out too, since it would be a no-op.
 *
 * Emacs and Neovim/Vim have no preset here: both are almost entirely chords or modal motions
 * (C-x C-s; `dd`, `ciw`), which the reasons above already rule out — a "preset" built only from
 * their handful of non-chord, non-modal keys would barely resemble either and isn't worth
 * shipping. Cursor, Windsurf and Zed are VS Code forks that keep its keymap, and Android Studio
 * runs on the IntelliJ platform with IntelliJ's own default keymap — all four would just be a
 * second copy of an existing preset here, so none gets one of its own. TextMate is left out for
 * a related reason: its real bindings pair Ctrl and Cmd as two separate modifiers on a Mac
 * keyboard, which has no honest equivalent on the Ctrl/Alt/Shift keyboard this app runs on
 * elsewhere. RStudio has no widely-used keymap extension to source one from.
 */
export const KEYBINDING_PRESETS: KeybindingPreset[] = [
  {
    id: "vscode",
    label: "VS Code (default)",
    bindings: {}
  },
  {
    // Source: github.com/isudox/vscode-jetbrains-keybindings
    id: "jetbrains",
    label: "JetBrains",
    bindings: {
      "ctrl+d": "editor.action.copyLinesDownAction",
      "ctrl+shift+up": "editor.action.moveLinesUpAction",
      "ctrl+shift+down": "editor.action.moveLinesDownAction",
      "ctrl+y": "editor.action.deleteLines",
      "ctrl+-": "editor.fold",
      "ctrl+=": "editor.unfold",
      "ctrl+shift+-": "editor.foldAll",
      "ctrl+shift+=": "editor.unfoldAll",
      "ctrl+r": "editor.action.startFindReplaceAction"
    }
  },
  {
    // Source: github.com/microsoft/vscode-sublime-keybindings
    id: "sublime",
    label: "Sublime Text",
    bindings: {
      "ctrl+shift+up": "editor.action.moveLinesUpAction",
      "ctrl+shift+down": "editor.action.moveLinesDownAction",
      "ctrl+shift+/": "editor.action.commentLine",
      "ctrl+shift+[": "editor.fold",
      "ctrl+shift+]": "editor.unfold",
      "ctrl+shift+d": "editor.action.copyLinesDownAction",
      "alt+shift+up": "editor.action.insertCursorAbove",
      "alt+shift+down": "editor.action.insertCursorBelow"
    }
  },
  {
    // Source: github.com/Grogdunn/vscode-nb-keybinding
    id: "netbeans",
    label: "NetBeans",
    bindings: {
      "ctrl+shift+c": "editor.action.commentLine",
      "ctrl+e": "editor.action.deleteLines",
      "ctrl+shift+down": "editor.action.copyLinesDownAction",
      "ctrl+shift+up": "editor.action.copyLinesUpAction",
      "alt+shift+down": "editor.action.moveLinesDownAction",
      "alt+shift+up": "editor.action.moveLinesUpAction",
      "alt+up": "editor.action.insertCursorAbove",
      "alt+down": "editor.action.insertCursorBelow",
      "ctrl+numpad_subtract": "editor.fold",
      "ctrl+numpad_add": "editor.unfold",
      "ctrl+shift+numpad_subtract": "editor.foldAll",
      "ctrl+shift+numpad_add": "editor.unfoldAll"
    }
  },
  {
    // Source: github.com/microsoft/vscode-vs-keybindings. Thin on purpose: Visual Studio's real
    // defaults for comment/move-line are chords or not built in at all, so those two are all
    // that carries over.
    id: "visualstudio",
    label: "Visual Studio",
    bindings: {
      "ctrl+shift+l": "editor.action.deleteLines",
      "ctrl+d": "editor.action.copyLinesDownAction"
    }
  },
  {
    // Source: github.com/alphabotsec/vscode-eclipse-keybindings
    id: "eclipse",
    label: "Eclipse",
    bindings: {
      "ctrl+shift+c": "editor.action.commentLine",
      "ctrl+alt+down": "editor.action.copyLinesDownAction",
      "ctrl+alt+up": "editor.action.copyLinesUpAction",
      "ctrl+d": "editor.action.deleteLines"
    }
  },
  {
    // Source: github.com/stevemoser/vscode-xcode-keybindings. Xcode is Mac-only, so its own
    // keymap is written with "cmd" throughout; translated to "ctrl" here, since this editor's
    // KeyMod.CtrlCmd already resolves to the right modifier per platform on its own (see
    // parseKeyCombo) and every other preset spells it that way.
    id: "xcode",
    label: "Xcode",
    bindings: {
      "alt+ctrl+left": "editor.fold",
      "alt+ctrl+right": "editor.unfold",
      "alt+ctrl+[": "editor.action.moveLinesUpAction",
      "alt+ctrl+]": "editor.action.moveLinesDownAction",
      "ctrl+shift+up": "editor.action.insertCursorAbove",
      "ctrl+shift+down": "editor.action.insertCursorBelow"
    }
  },
  {
    // Source: github.com/microsoft/vscode-notepadplusplus-keybindings
    id: "notepad++",
    label: "Notepad++",
    bindings: {
      "alt+0": "editor.foldAll",
      "shift+alt+0": "editor.unfoldAll",
      "ctrl+q": "editor.action.commentLine",
      "ctrl+shift+down": "editor.action.moveLinesDownAction",
      "ctrl+shift+up": "editor.action.moveLinesUpAction",
      "ctrl+l": "editor.action.deleteLines"
    }
  },
  {
    // Source: github.com/microsoft/vscode-atom-keybindings
    id: "atom",
    label: "Atom",
    bindings: {
      "ctrl+up": "editor.action.moveLinesUpAction",
      "ctrl+down": "editor.action.moveLinesDownAction",
      "ctrl+shift+d": "editor.action.copyLinesDownAction",
      "alt+ctrl+[": "editor.fold",
      "alt+ctrl+]": "editor.unfold",
      "alt+ctrl+shift+[": "editor.foldAll",
      "alt+ctrl+shift+]": "editor.unfoldAll"
    }
  },
  {
    // Source: github.com/microsoft/vscode-brackets-keybindings
    id: "brackets",
    label: "Brackets",
    bindings: {
      "ctrl+d": "editor.action.copyLinesDownAction",
      "ctrl+shift+d": "editor.action.deleteLines",
      "ctrl+shift+up": "editor.action.moveLinesUpAction",
      "ctrl+shift+down": "editor.action.moveLinesDownAction",
      "ctrl+shift+/": "editor.action.blockComment"
    }
  }
];
