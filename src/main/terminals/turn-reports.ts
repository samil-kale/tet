import { getAgent } from "../agents";
import type { HookEvent } from "../../shared/ctl";
import type { NoticeMark } from "../../shared/types/app";
import type { NotificationSettings } from "../../shared/types/settings";
import { endLeavesQuestion, endTurnQuietly, setTurn, type TabState } from "./tab-state";
import { reportApplies } from "./turn-order";

/** What a hook shows the user (ctl-verb.ts's ControlTerminals.hookEvent). */
export interface HookNotification {
  title: string;
  body: string;
  mark: NoticeMark;
}

export type NotificationKind = "finished" | "permission" | "question" | "idle";

/** What a report did to its tab: whether the marks changed, and what the user is to be told. */
export interface TurnReportOutcome {
  changed: boolean;
  notify?: NotificationKind;
}

const UNCHANGED: TurnReportOutcome = { changed: false };

/**
 * A hook report applied to its tab's marks ("Turns and tab marks" in AGENTS.md), the tab changed in
 * place. `at` is when the hook *fired*, not arrived (turn-order.ts).
 */
export function applyTurnReport(tab: TabState, event: HookEvent, payload: string, at: number): TurnReportOutcome {
  // A stale report gets no mark and no notification, which would contradict the marks — "Finished" over
  // a tab working again (turn-order.ts).
  const fresh = reportApplies(tab.turnReportAt, at);
  // A report sent before the exit can arrive after it (Codex's aborted hook, an extension's post, a
  // sandbox's latency) and would mark a tab whose process is gone until the next stop.
  const exited = tab.status === "stopped" || tab.status === "error";
  switch (event) {
    case "session-start":
      // Only names the session (bindReportedSession). Codex fires it with the first prompt, whose turn
      // prompt-submit marks.
      return UNCHANGED;
    case "prompt-submit":
      if (fresh && !exited) {
        setTurn(tab, true, at);
        // No context for the model: TET's system prompt went in once per session (system-prompt.ts).
        return { changed: true };
      }
      return UNCHANGED;
    case "stop": {
      if (!fresh) {
        return UNCHANGED;
      }
      const agent = getAgent(tab.agentId);
      if (agent.turns?.workOutlivesStop?.(payload)) {
        return UNCHANGED;
      }
      // Only pi's extension reports a turn the user cut short (its `aborted`): it ends as
      // reconcile ends one, no mark and no notification.
      if (agent.turns?.stopCutShort?.(payload)) {
        endTurnQuietly(tab);
        tab.turnReportAt = at;
        return { changed: true };
      }
      // Read before setTurn, which may clear it.
      const asked = endLeavesQuestion(tab, agent);
      setTurn(tab, false, at, asked);
      // The question already notified this moment (see setTurn).
      return asked ? { changed: true } : { changed: true, notify: "finished" };
    }
    case "permission":
    case "question":
      if (!fresh || exited) {
        return UNCHANGED;
      }
      // Not through setTurn: the turn is still open, `inTurn` is untouched.
      tab.turnReportAt = at;
      // One question can report twice (Claude Code's AskUserQuestion fires `question` and then
      // `permission`): the mark and the notification are the first one's.
      if (tab.waitingAt !== undefined) {
        return UNCHANGED;
      }
      tab.waitingAt = at;
      return { changed: true, notify: event };
    case "answered":
      // The dialog closed, whatever closed it; the turn, if any, runs on.
      if (!fresh || exited || tab.waitingAt === undefined) {
        return UNCHANGED;
      }
      tab.waitingAt = undefined;
      tab.turnReportAt = at;
      return { changed: true };
    case "idle":
      // About a turn already ended — nothing to mark. Its hook exists only while the switch is on
      // (AgentPaths.idleReminder), rather than a process per idle prompt answered with nothing.
      return fresh ? { changed: false, notify: "idle" } : UNCHANGED;
  }
}

/**
 * Records the session a report names, for a tab with none or one that moved on (`/clear`, `/new`,
 * `/resume`). Whatever the turn marks' age (`turnReportAt`), but
 * ordered against the reports naming sessions (turn-order.ts): a late hook of the session left
 * behind would take it back. Reconcile claims it once listed; the session left behind becomes its
 * own tab next start.
 *
 * Whether the tab named a session it had not before.
 */
export function bindReportedSession(tab: TabState, reported: string, at: number): boolean {
  if (!reportApplies(tab.sessionReportAt, at)) {
    return false;
  }
  tab.sessionReportAt = at;
  if (reported === tab.reportedSessionId) {
    return false;
  }
  tab.reportedSessionId = reported;
  return true;
}

/** The settings read at the event, so a switch applies to the next turn of every open project. */
export function notificationFor(
  tab: TabState,
  kind: NotificationKind,
  placeName: string,
  notifications: NotificationSettings,
): HookNotification | undefined {
  const wanted = kind === "finished" ? notifications.finished : kind === "idle" ? notifications.idleReminder : notifications.waiting;
  if (!wanted) {
    return undefined;
  }
  const name = getAgent(tab.agentId).displayName;
  // The tab's title too, or two tabs of one agent would read alike.
  const where = tab.title ? `${placeName} - ${tab.title}` : placeName;
  switch (kind) {
    case "finished":
      return { title: `${name}: Finished`, body: where, mark: "finished" };
    case "permission":
      return { title: `${name}: Permission`, body: where, mark: "waiting" };
    case "question":
      return { title: `${name}: Question`, body: where, mark: "waiting" };
    case "idle":
      return { title: `${name}: Idle`, body: where, mark: "finished" };
  }
}
