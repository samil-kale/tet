import { ipcRenderer } from "electron";
import type { SendChannels } from "../shared/ipc";

/**
 * A browser tab's page's preload (browser/browser-tabs.ts's PAGE_PREFERENCES), in a world of its
 * own the page never reaches: it exposes nothing. A page takes its keys before the window sees
 * them, so a key press with Ctrl or Cmd that the page left alone — not handled (`defaultPrevented`),
 * and typed, not dispatched by the page's script (`isTrusted`) — goes to main, which takes the
 * window's shortcuts from it, as VS Code's browser does. Listening last, on `window` while bubbling,
 * it hears what the page did first.
 */
function send<C extends keyof SendChannels>(channel: C, ...args: Parameters<SendChannels[C]>): void {
  ipcRenderer.send(channel, ...args);
}

window.addEventListener("keydown", (event) => {
  if (!event.isTrusted || event.defaultPrevented || !(event.ctrlKey || event.metaKey)) {
    return;
  }
  const { key, code, shiftKey, altKey, ctrlKey, metaKey } = event;
  send("browser:page-key", { key, code, shiftKey, altKey, ctrlKey, metaKey });
});
