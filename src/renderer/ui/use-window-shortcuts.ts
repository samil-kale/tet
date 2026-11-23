import { useEffect } from "react";
import { shortcutOfEvent, type ShortcutId } from "../shortcuts";
import { useLatest } from "./use-latest";
import { isWindowCovered } from "./window-covered";

/**
 * The window's shortcuts, on `document` in the capture phase to beat xterm's textarea listener.
 * xterm never encodes any of them; the actions are read on the key, so the listener is registered
 * once however often they are remade. None acts behind a dialog, whose key it stays: the window
 * under it is inert, and Escape closes the last one opened (use-escape.ts), which has to be the
 * one on top.
 */
export function useWindowShortcuts(actions: Record<ShortcutId, () => void>): void {
  const latest = useLatest(actions);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = shortcutOfEvent(event);
      if (shortcut && !isWindowCovered()) {
        event.preventDefault();
        event.stopPropagation();
        latest.current[shortcut]();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [latest]);
}
