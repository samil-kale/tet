import { useEffect } from "react";
import { matchesShortcut, SHORTCUTS, type ShortcutId } from "../shortcuts";
import { useLatest } from "./use-latest";

/**
 * The window's shortcuts, on `document` in the capture phase to beat xterm's textarea listener.
 * xterm never encodes any of them — see `shortcuts.ts`. The actions are read on the key, so the
 * listener is registered once however often they are remade.
 */
export function useWindowShortcuts(actions: Record<ShortcutId, () => void>): void {
  const latest = useLatest(actions);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = SHORTCUTS.find(({ id }) => matchesShortcut(event, id));
      if (shortcut) {
        event.preventDefault();
        event.stopPropagation();
        latest.current[shortcut.id]();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [latest]);
}
