/** Whether `input` toggles DevTools, as Chrome's F12 and Ctrl+Shift+I do: for TET's own page
 *  (window.ts) and a browser tab's page (browser/browser-tabs.ts) alike. */
export function isDevToolsKey(input: Electron.Input): boolean {
  return input.type === "keyDown" && (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i"));
}
