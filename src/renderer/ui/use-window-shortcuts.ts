import { useEffect } from "react";
import { shortcutOfEvent, type ShortcutId } from "../shortcuts";
import { useLatest } from "./use-latest";

/**
 * The window's shortcuts, on `document` in the capture phase to beat xterm's textarea listener.
 * xterm never encodes any of them — see `shortcuts.ts`. A browser tab's page takes its keys before
 * the window sees them, so main matches them there and hands them on (`browser.onShortcut`). The
 * actions are read on the key, so the listener is registered once however often they are remade.
 */
export function useWindowShortcuts(actions: Record<ShortcutId, () => void>): void {
  const latest = useLatest(actions);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = shortcutOfEvent(event);
      if (shortcut) {
        event.preventDefault();
        event.stopPropagation();
        latest.current[shortcut]();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    const offPage = window.tet.browser.onShortcut((shortcut) => latest.current[shortcut]());
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      offPage();
    };
  }, [latest]);
}
