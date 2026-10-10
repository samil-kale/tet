/** Whether the input toggles TET's DevTools, as Chrome's F12 and Ctrl+Shift+I do. */
export function isDevToolsKey(input: Electron.Input): boolean {
  return input.type === "keyDown" && (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i"));
}
