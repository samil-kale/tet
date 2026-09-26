import { useEffect, useRef } from "react";
import type { AgentInfo, CheckoutRef } from "../../shared/types";
import { attachTerminal, fitTerminal, hasTerminal } from "./terminal-views";

interface TerminalHostProps {
  checkout: CheckoutRef;
  tabId: string;
  /**
   * The view bakes the agent's flags in at construction (see theme.ts). Undefined until
   * `agents.list()` resolves, and attaching waits: a view built without them keeps them wrong.
   */
  agent: AgentInfo | undefined;
  /** The one on screen in its pane; the others keep their layout but stay hidden. */
  active: boolean;
  /** Whether the pane itself is on screen — the checkout is the one selected. */
  visible: boolean;
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
export function TerminalHost({ checkout, tabId, agent, active, visible }: TerminalHostProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (container.current && agent && ((active && visible) || hasTerminal(checkout, tabId))) {
      const created = !hasTerminal(checkout, tabId);
      attachTerminal(checkout, tabId, agent, container.current);
      // Pane's fit may have come first, with no view to fit (agents listed or the tab pushed late),
      // and nothing reruns it. The first fit starts the process; in the same commit, Pane's own
      // follows and reports nothing new (`fitTerminal`).
      if (created && active && visible) {
        fitTerminal(checkout, tabId);
      }
    }
  }, [checkout, tabId, agent, active, visible]);

  // "hidden" is visibility, not display — xterm needs a laid-out element to measure itself.
  return <div ref={container} className={`terminal-host${active ? "" : " hidden"}`} />;
}
