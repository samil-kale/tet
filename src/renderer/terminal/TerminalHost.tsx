import { useEffect, useRef } from "react";
import type { AgentInfo } from "../../shared/types";
import { attachTerminal, hasTerminal } from "./terminal-views";

interface TerminalHostProps {
  projectId: string;
  tabId: string;
  /**
   * The view bakes the agent's flags in at construction (see theme.ts). Undefined until
   * `agents.list()` resolves, and attaching waits: a view built without them keeps them wrong.
   */
  agent: AgentInfo | undefined;
  /** The one on screen in its pane; the others keep their layout but stay hidden. */
  active: boolean;
  /** Whether the pane itself is on screen — the project is the one selected. */
  visible: boolean;
}

/**
 * Where one xterm is mounted. The instance lives outside React in `terminal-views.ts`; attaching
 * moves it into the DOM.
 *
 * Attached the first time the tab is in front of the user, not on mount: building every tab's
 * xterm at startup was most of the window's start. Nothing is lost: a tab's process starts on its
 * first fit, which needs the view.
 *
 * Once attached it stays attached. A tab moved into another pane gets a fresh host, and its xterm
 * follows at once, active or not: an unmounted container has no layout to take output into.
 */
export function TerminalHost({ projectId, tabId, agent, active, visible }: TerminalHostProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (container.current && agent && ((active && visible) || hasTerminal(projectId, tabId))) {
      attachTerminal(projectId, tabId, agent, container.current);
    }
  }, [projectId, tabId, agent, active, visible]);

  // "hidden" is visibility, not display — xterm needs a laid-out element to measure itself.
  return <div ref={container} className={`terminal-host${active ? "" : " hidden"}`} />;
}
