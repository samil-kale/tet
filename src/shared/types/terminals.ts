import type { AgentId } from "./agents";
import type { ActionDone, ActionRefused } from "./action";
import type { ProjectRef } from "./project";

/** The tab taking over a session, or why there is none. */
export type HandoverResult = (ActionDone & { tab: TabDescriptor }) | ActionRefused;

/** What linking a session to an issue changed beside the link: the issue it was taken off
 *  (`movedFrom`), and whether the issue's own session gave way (`replacedSession`). */
export interface IssueLinkChange {
  movedFrom?: number;
  replacedSession?: true;
}

/** A session linked to an issue, with what that changed, or why it was not. */
export type LinkIssueResult = (ActionDone & IssueLinkChange) | ActionRefused;

/** A tab, addressed by its repository or worktree and its id. */
export interface TabRef {
  ref: ProjectRef;
  tabId: string;
}

/** One terminal's output since the last flush. Batched, so the message count does not grow with
 *  the number of open terminals. */
export interface TerminalOutput extends TabRef {
  data: string;
}

export const TERMINAL_STATUSES = ["missing", "ready", "running", "stopped", "error"] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface TabDescriptor {
  /** Unique within its repository or worktree; equals the agent's session id for a restored tab. */
  tabId: string;
  agentId: AgentId;
  /** Session title; "" makes the UI show a placeholder. */
  title: string;
  status: TerminalStatus;
  /** The agent's session id; absent until the CLI persisted one. Equals `tabId` for a restored tab,
   *  hence the split layout's key. */
  sessionId?: string;
  /** Last activity, ms since epoch; absent without a session. */
  updatedAt?: number;
  /** ms since epoch; absent without a session. */
  createdAt?: number;
  /** Last turn finished unseen, ms since epoch; cleared once on screen (`tabs.seen`). A time, not a
   *  flag: the project row's mark opens the oldest first. */
  finishedAt?: number;
  /** Working a turn — reported by the agent at both ends, never read off the TUI. False once the
   *  process has ended. */
  inTurn?: boolean;
  /** This tab's pane shows the progress bar: runtime being prepared, or CLI before its first frame.
   *  Read off the session manager's per-tab indicator count at each snapshot. */
  starting?: boolean;
  /** Stopped mid-turn on an unanswered question, ms since epoch. Cleared like `finishedAt` and by
   *  either end of a turn. Not a shade of `inTurn`: such a session is *not* working. */
  waitingAt?: number;
  /** Runs in its sbx sandbox: where its latest start ran it, until then where its session lives. */
  sandboxed?: boolean;
  /** A saved command's tab; only these offer Restart. */
  savedCommand?: boolean;
  /** Opened in the OS's terminal (`openInTerminal`), where its session runs on: no fit starts the tab,
   *  only Restart takes it back, and closing it deletes that session, so the window asks first. */
  openedInTerminal?: boolean;
  /** The saved command's line from `tet.json` — the split layout's `commandPane` key, so the next
   *  run lands where the last lay. The line, since `name` may be missing. */
  command?: string;
  /** The project's issue its session is linked to, or that it links once it has one (tracked-links.ts). */
  issue?: number;
  /** The project's change request, the same way. */
  changeRequest?: number;
}

/** The session linked to an issue or change request, as its tab shows it: its tab in the repository
 *  or a worktree, on the strip or archived. */
export interface IssueSession {
  ref: ProjectRef;
  /** The worktree's name; absent for the repository. */
  worktree?: string;
  tabId: string;
  agentId: AgentId;
  /** "" makes the UI show a placeholder, as a tab's. */
  title: string;
  archived: boolean;
}

/** The session linked to each of the project's issues that has one. */
export interface IssueSessionsResult {
  sessions?: Record<number, IssueSession>;
  error?: string;
}

/** As every spinner shows it: never while waiting on a question, whatever `inTurn` says. */
export function isWorking(tab: TabDescriptor): boolean {
  return tab.inTurn === true && tab.waitingAt === undefined;
}
