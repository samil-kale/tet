interface KeybindingPreset {
  id: string;
  label: string;
  bindings: Record<string, string>;
}

/**
 * Curated keymaps from each editor's VS Code keymap extension, trimmed to commands monaco-core.ts
 * registers and layered over the defaults by `resolveKeybindings`. No chords (`parseKeyCombo` takes
 * one combo), nothing equal to the default. Modal/chord-only editors and VS Code forks get none.
 */
export const KEYBINDING_PRESETS: KeybindingPreset[] = [
  {
    id: "vscode",
    label: "VS Code (default)",
    bindings: {}
  },
  {
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
      "ctrl+shift+=": "editor.unfoldAll"
    }
  },
  {
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
    // Its comment/move-line keys are chords or absent.
    id: "visualstudio",
    label: "Visual Studio",
    bindings: {
      "ctrl+shift+l": "editor.action.deleteLines",
      "ctrl+d": "editor.action.copyLinesDownAction"
    }
  },
  {
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
    // "cmd" written "ctrl": KeyMod.CtrlCmd resolves per platform (parseKeyCombo).
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
