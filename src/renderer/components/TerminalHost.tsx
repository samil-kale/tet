import { useEffect, useRef } from "react";
import type { AgentInfo } from "../../shared/types";
import { attachTerminal, hasTerminal } from "../terminal-views";

interface TerminalHostProps {
  projectId: string;
  tabId: string;
  /**
   * Which agent's terminal this is — the view bakes its flags in at construction (one colour
   * of the theme among them, see theme.ts). Undefined until the pane's `agents.list()` call
   * resolves, which is why attaching waits for it below: a view built without the flags would
   * keep the wrong ones for its whole life.
   */
  agent: AgentInfo | undefined;
  /** The one on screen in its pane; the others keep their layout but stay hidden. */
  active: boolean;
  /** Whether the pane itself is on screen — the project is the one selected. */
  visible: boolean;
}

/**
 * Where one xterm instance is mounted. The instance lives outside React in `terminal-views.ts`
 * and survives this component — attaching is what moves it into the DOM.
 *
 * Attached the first time the tab is actually in front of the user, not on mount: every tab of
 * every project mounts at startup, and building an xterm — theme read off the stylesheet, its
 * DOM, a character measurement — for each of them, before the first paint, was most of what the
 * window did while coming up. Nothing is lost by waiting: a tab's process is only started by
 * its first fit, which needs the view, and output for a view that does not exist is dropped by
 * `terminal-views` for a tab that cannot have produced any.
 *
 * Once attached it stays attached — to a container that is in the tree. A tab moved into another
 * pane of the split, or whose pane the preset put somewhere else, gets a fresh host mounted for
 * it, and its xterm follows at once whether or not it is the active tab there: left in the old,
 * unmounted container it would keep taking output into a node with no layout, which is exactly
 * what the `visibility` rule below exists to prevent for a hidden tab.
 */
export function TerminalHost({ projectId, tabId, agent, active, visible }: TerminalHostProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (container.current && agent && ((active && visible) || hasTerminal(projectId, tabId))) {
      attachTerminal(projectId, tabId, agent, container.current);
    }
  }, [projectId, tabId, agent, active, visible]);

  // "hidden" is visibility, not display — xterm needs a laid-out element to measure itself,
  // both when it opens and when output arrives for a background tab.
  return <div ref={container} className={`terminal-host${active ? "" : " hidden"}`} />;
}
