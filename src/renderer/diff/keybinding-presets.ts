export interface KeybindingPreset {
  id: string;
  label: string;
  bindings: Record<string, string>;
}

/**
 * Curated per-editor keymaps, each sourced from that editor's VS Code keymap extension and
 * trimmed to the commands monaco-core.ts registers; `resolveKeybindings` layers the chosen one
 * over this editor's defaults in memory. No chords (`parseKeyCombo` takes one combo), no
 * bindings identical to the default. Modal/chord-only editors and VS Code forks have no preset.
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
    // Source: github.com/microsoft/vscode-vs-keybindings. Visual Studio's comment/move-line
    // defaults are chords or absent, so only these two carry over.
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
    // Source: github.com/stevemoser/vscode-xcode-keybindings. Xcode's "cmd" is written "ctrl"
    // here: KeyMod.CtrlCmd resolves per platform (see parseKeyCombo).
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
