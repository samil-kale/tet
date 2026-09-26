// monaco-editor ships no declarations for its internals; `fromUserSettings` is the one export read
// (parseKeyCombo in diff/keybindings.ts). It returns 0 for a name it doesn't know.
declare module "monaco-editor/base/common/keyCodes.js" {
  export const KeyCodeUtils: { fromUserSettings(key: string): number };
}
