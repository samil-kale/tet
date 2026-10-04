import type { AgentDefinition } from "../agents/agent";
import type { TabDescriptor } from "../../shared/types/terminals";
import type { HandoverFiles, TabPlace } from "./tab-place";

/** A tab as its session manager holds it, and what reads or sets its marks. */

export interface TabState extends TabDescriptor {
  /** The session this tab's hooks named (AgentTurns.sessionIdOf), claimed as `sessionId`
   *  once listed. */
  reportedSessionId?: string;
  /** When the latest report naming a session was made (ControlRequest.at) — see bindReportedSession. */
  sessionReportAt?: number;
  /** When Enter last went into this tab while it had named no session — see reportBeforeQuit. */
  submittedAt?: number;
  /** Mirrors AgentSessionInfo.provisionalTitle. */
  provisionalTitle?: boolean;
  /** Mirrors AgentSessionInfo.sandbox. */
  sandbox?: string;
  /** Where its latest start ran it (resolvePlace); until then where its session lives (placeOf). */
  place?: TabPlace;
  /** Opened by `tet-ctl` from a sandbox: runs in the sandbox or not at all (resolvePlace), or the
   *  sandbox could disable SBX in tet.json and open itself a tab on this machine. */
  sandboxOnly?: true;
  /** When the running turn was reported started — what a turn end is dated against. */
  turnStartedAt?: number;
  /**
   * When the latest applied turn report was made (ControlRequest.at). Two hooks can race to the
   * channel (a question just before the turn ends); an older one is dropped (turn-order.ts).
   */
  turnReportAt?: number;
  /** A saved command's program, when not this agent's executable. */
  executable?: string;
  /** A saved command's arguments — its program's, or a shell's when it asked for one. */
  runArgs?: string[];
  /** The process's folder, when not the repository or worktree root. */
  cwd?: string;
  /** A saved command's variables, outranking the machine's. */
  env?: Record<string, string>;
  /** The prompt a new tab starts with (AgentTerminal.initialPromptArgs), on its first start only:
   *  a restart would submit it again. */
  initialPrompt?: string;
  /** Another agent's session this tab takes over (handOver), handed over as it is — never converted,
   *  so no format change of the agent's breaks it — and made its first prompt on its first start,
   *  once it is known where the tab runs. Dropped then, like `initialPrompt`. */
  handover?: HandoverFiles;
  /** A handover's copy its start made (Launch.handoverDir), deleted with the tab. */
  handoverDir?: string;
}

/** This tab's hooks named a session it has not claimed: its first, or one it moved on to. */
export function awaitsClaim(tab: TabState): boolean {
  return tab.reportedSessionId !== undefined && tab.reportedSessionId !== tab.sessionId;
}

/** No session claimed, no title, or only a stand-in the agent may still replace. */
export function titleUnsettled(tab: TabState): boolean {
  return !tab.sessionId || awaitsClaim(tab) || !tab.title || tab.provisionalTitle === true;
}

/**
 * A turn started or ended. Either end clears `waitingAt` — a question stands within its turn.
 *
 * `keepQuestion`, for AgentTurns.questionOutlivesTurn: the question stays **and the end
 * leaves no bubble beside it** — one moment, and the project row, with a button per condition,
 * would step through that tab twice. The question is the more urgent and actionable of the two.
 *
 * Only pi reports an answered question (`answered`), so another agent's permission granted
 * mid-turn keeps the mark until the tab is typed into.
 */
export function setTurn(tab: TabState, inTurn: boolean, at: number, keepQuestion = false): void {
  tab.inTurn = inTurn;
  tab.turnReportAt = at;
  if (inTurn) {
    tab.waitingAt = undefined;
    tab.turnStartedAt = at;
    return;
  }
  if (keepQuestion && tab.waitingAt !== undefined) {
    return;
  }
  tab.waitingAt = undefined;
  tab.finishedAt = at;
}

/** Whether a question left standing already said this turn's end — see setTurn. */
export function endLeavesQuestion(tab: TabState, agent: AgentDefinition): boolean {
  return agent.turns?.questionOutlivesTurn === true && tab.waitingAt !== undefined;
}

/**
 * Whether terminal input can answer a standing question — see `write`. Besides pi's `answered`,
 * this and either end of the turn (setTurn) are what clear the mark. Enter, a printable
 * character (Claude Code's permission prompt takes a digit without Enter) and an SGR mouse press
 * (`ESC [ < button ; x ; y M`). Not arrows, Tab, Shift+Tab, a bare Escape, motion (bit 32) or the
 * wheel (64+). Generous: a mark dropped early is on a tab being typed into, which hides it anyway.
 */
export function answersQuestion(data: string): boolean {
  if (data.includes("\r") || data.includes("\n")) {
    return true;
  }
  // eslint-disable-next-line no-control-regex
  const mouse = /\x1b\[<(\d+);\d+;\d+M/.exec(data);
  if (mouse) {
    const button = Number(mouse[1]);
    return (button & 32) === 0 && button < 64;
  }
  // Arrows, function keys, a bare ESC.
  if (data.startsWith("\x1b")) {
    return false;
  }
  return /\S/.test(data);
}

/** `starting` comes from the caller's `indicators`, `sandboxed` from its `placeOf`. */
export function toDescriptor(tab: TabState, starting: boolean, sandboxed: boolean): TabDescriptor {
  const { tabId, agentId, title, updatedAt, createdAt, status, sessionId, finishedAt, inTurn, waitingAt, command } = tab;
  return {
    tabId,
    agentId,
    title,
    updatedAt,
    createdAt,
    status,
    finishedAt,
    inTurn,
    waitingAt,
    starting,
    sandboxed,
    sessionId,
    savedCommand: isSavedCommandTab(tab),
    command
  };
}

/** Either field is set only by `createCommandTab`. */
export function isSavedCommandTab(tab: TabState): boolean {
  return tab.executable !== undefined || tab.runArgs !== undefined;
}

/** Resumes this tab's session, on the host or in its sandbox alike. */
export function resumeArgsOf(tab: TabState, agent: AgentDefinition): string[] {
  return tab.sessionId && agent.sessions ? agent.sessions.resumeArgs(tab.sessionId) : [];
}
