import type { AgentInfo, AgentId } from "../../../shared/types/agents";
import type { TrackedDetail } from "../../../shared/types/providers";
import type { TrackedSession } from "../../../shared/types/terminals";
import { agentEntry, AgentIcon } from "../../ui/agent-icons";
import { BAR_MENU_DROP, useAnchoredMenu, type ContextMenuEntry } from "../../ui/ContextMenu";
import { askName, confirmed } from "../../ui/Dialog";
import { IconButton } from "../../ui/IconButton";
import { RemoteIcon, SquareSparklesIcon, PencilIcon, TrashIcon } from "../../ui/icons";
import { useAgents } from "../../ui/use-agents";
import { openTrackedSession } from "../editor-tab";
import type { TrackedActions } from "./tracked-actions";
import { changeRequestOf, numberOf, stateOf, trackedNoun } from "./tracked-words";

/** The question renaming an issue asks, wherever it is offered. */
export function askTrackedTitle(
  current: string,
  submit: (title: string) => Promise<string | undefined>,
  issue?: TrackedDetail,
): Promise<void> {
  const noun = issue ? trackedNoun(issue).toLowerCase() : "issue";
  return askName({ title: `Rename ${noun}`, label: "Title", current, confirmLabel: "Rename", submit });
}

/** The question deleting an issue asks, wherever it is offered. */
export function confirmDeleteIssue(number: number): Promise<boolean> {
  return confirmed({
    title: "Delete issue",
    message: `Delete issue #${number}?`,
    detail: "It is deleted on the tracker for good, with its comments.",
    confirmLabel: "Delete",
  });
}

/** The question deleting a comment or a time entry asks: it is deleted on the tracker for good. */
export function confirmDeleteOnTracker(what: string): Promise<boolean> {
  return confirmed({
    title: `Delete ${what}`,
    message: `Delete this ${what}?`,
    detail: "It is deleted on the tracker for good.",
    confirmLabel: "Delete",
  });
}

/** The agents an issue can be opened in, wherever that is offered: those a prompt can start. */
export function trackedAgentEntries(agents: readonly AgentInfo[], open: (agentId: AgentId) => void): ContextMenuEntry[] {
  return agents.filter((agent) => agent.takesPrompt).map((agent) => agentEntry(agent, () => open(agent.id)));
}

/** A menu's entry for an issue: its session opened where it has one, as an issue has one, else the
 *  agents to send it to. */
export function trackedSessionEntry(
  session: TrackedSession | undefined,
  agents: readonly AgentInfo[],
  send: (agentId: AgentId) => void,
): ContextMenuEntry {
  return session
    ? { label: "Open Session", run: () => void openTrackedSession(session) }
    : { label: "Send to Agent", entries: trackedAgentEntries(agents, send) };
}

/** The tab's bar, as a file's: what can be done to the issue, its state, then what names it. An issue
 *  with a session offers to open it, by its agent's icon, in place of sending it to an agent. */
export function TrackedBar({
  issue,
  session,
  actions,
}: {
  issue: TrackedDetail;
  session: TrackedSession | undefined;
  actions: TrackedActions;
}) {
  const agents = useAgents();
  const request = changeRequestOf(issue);
  // As a pane's new-tab menu: a button's padding off it, and beside the bar, whose stacking it slides
  // out from behind.
  const agentMenu = useAnchoredMenu((rect) => ({ x: rect.left - 6, y: rect.bottom + BAR_MENU_DROP }), true);
  const agentEntries = (): ContextMenuEntry[] => {
    const offered = trackedAgentEntries(agents, actions.sendToAgent);
    return offered.length > 0 ? offered : [{ label: "No agent installed" }];
  };
  return (
    <>
      <div className="editor-bar tracked-bar">
        <div className="toolbar editor-bar-actions">
          <IconButton title="Open in Browser" onClick={() => void window.tet.shell.openUrl(issue.url)}>
            <RemoteIcon />
          </IconButton>
          {session ? (
            <IconButton title="Open Session" onClick={() => void openTrackedSession(session)}>
              <AgentIcon agentId={session.agentId} className="line-icon" />
            </IconButton>
          ) : (
            <button type="button" className="icon-button" title="Send to Agent" onMouseDown={agentMenu.open}>
              <SquareSparklesIcon />
            </button>
          )}
          <IconButton title={`Rename ${trackedNoun(issue)}...`} onClick={() => void askTrackedTitle(issue.title, actions.rename, issue)}>
            <PencilIcon />
          </IconButton>
          {/* A change request is closed, never deleted. */}
          {!request && (
            <IconButton
              title="Delete Issue..."
              onClick={() => void confirmDeleteIssue(issue.number).then((answer) => (answer ? actions.deleteIssue() : undefined))}
            >
              <TrashIcon />
            </IconButton>
          )}
        </div>
        <div className="toolbar editor-bar-actions tracked-state">{stateOf(issue)}</div>
        <div className="toolbar editor-bar-actions tracked-bar-number">{numberOf(issue)}</div>
        <span className="editor-bar-title" title={issue.title}>
          {issue.title}
        </span>
      </div>
      {agentMenu.render(agentEntries, "new-tab-menu")}
    </>
  );
}
