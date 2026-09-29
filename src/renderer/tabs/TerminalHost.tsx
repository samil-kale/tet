import { useEffect, useRef } from "react";
import type { ProjectRef } from "../../shared/types/project";
import { attachTerminal, fitTerminal, focusTerminal, hasTerminal, hideTerminal, showTerminal } from "./terminal-views";

/** A window-edge drag fires dozens of observations; every pty resize repaints the TUI. */
const RESIZE_DEBOUNCE_MS = 100;

interface TerminalHostProps {
  at: ProjectRef;
  tabId: string;
  /** What Shift+Enter sends, its agent's (AgentInfo.shiftEnter); unset: the terminal's own. */
  shiftEnter: string | undefined;
  /** The one on screen in its pane; the others keep their layout but stay hidden. */
  active: boolean;
  /** Whether the pane itself is on screen — the repository or worktree is the one selected. */
  visible: boolean;
  /** In the repository's or worktree's focused pane, which gets keyboard focus. */
  focused: boolean;
}

/**
 * Where one xterm is mounted. The instance lives outside React in `terminal-views.ts`; attaching
 * moves it into the DOM.
 *
 * Attached the first time the tab is in front of the user, not on mount: building every tab's
 * xterm at startup costs most of the window's start. Nothing is lost: a tab's process starts on its
 * first fit, which needs the view.
 *
 * Once attached it stays attached. A tab moved into another pane gets a fresh host, and its xterm
 * follows at once, active or not: an unmounted container has no layout to take output into.
 */
export function TerminalHost({ at, tabId, shiftEnter, active, visible, focused }: TerminalHostProps) {
  const container = useRef<HTMLDivElement>(null);
  const shown = active && visible;

  // Refit on coming in front: hidden, its size went stale. The resize also starts its process.
  // Shown before the fit, since the renderer decides the cell width the fit measures
  // (`showTerminal`).
  useEffect(() => {
    if (!container.current || (!shown && !hasTerminal(at, tabId))) {
      return;
    }
    attachTerminal(at, tabId, container.current, shiftEnter);
    if (!shown) {
      return;
    }
    showTerminal(at, tabId);
    fitTerminal(at, tabId);
    return () => hideTerminal(at, tabId);
  }, [at, tabId, shiftEnter, shown]);

  // Keyboard focus follows the focused pane's active tab — only that one, or the last effect wins.
  // Apart from the refit: a focus change alone must not resize the pty (repaints the CLI).
  useEffect(() => {
    if (shown && focused) {
      focusTerminal(at, tabId);
    }
  }, [at, tabId, shown, focused]);

  useEffect(() => {
    const element = container.current;
    if (!element || !shown) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only the debounced pty resize, never an immediate local reflow: xterm reflowed ahead of the
    // pty has a CLI's redraw land on a ConPTY buffer reflowed for a size it doesn't know yet
    // (`fitTerminal`). The trade: a dragged sash shows background until it settles.
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => fitTerminal(at, tabId), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [at, tabId, shown]);

  // "hidden" is visibility, not display — xterm needs a laid-out element to measure itself.
  return <div ref={container} className={`terminal-host${active ? "" : " hidden"}`} />;
}
