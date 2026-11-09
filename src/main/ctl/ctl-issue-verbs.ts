import type { ControlVerbName } from "../../shared/ctl";
import {
  bringToFront,
  ControlError,
  openableAgent,
  optionalText,
  positiveInteger,
  refusable,
  text,
  type ControlDeps,
  type Handler,
  type RefFrom,
} from "./ctl-verb";

/**
 * The issue verbs. The tracker is the project's, so the verbs asking it act on the project of the
 * repository or worktree `refFrom` finds (resolveCallerRef), whichever of them that is.
 */
export function issueVerbs(deps: ControlDeps, refFrom: RefFrom): Record<Extract<ControlVerbName, `issues-${string}`>, Handler> {
  /** The first positional, an issue's number. */
  const issueNumber = (args: Record<string, unknown>): number => {
    const typed = text(args, "number", "issue number");
    const number = positiveInteger(typed);
    if (number === undefined) {
      throw new ControlError("bad_args", `not an issue number: ${typed}`);
    }
    return number;
  };

  return {
    "issues-set-source": (args, caller) => {
      const { project } = refFrom(args, caller);
      const source = optionalText(args, "source") ?? "";
      return refusable(async () => ({ result: { source: (await deps.setIssueSource(project.id, source)) ?? null } }));
    },

    "issues-get-source": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => ({ result: await deps.readIssueTracker(project.id) }));
    },

    "issues-unread": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => {
        const unread = await deps.unreadIssues(project.id);
        return { result: unread.map(({ number, title, url, updatedAt }) => ({ number, title, url, updatedAt })) };
      });
    },

    "issues-mark-seen": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = optionalText(args, "number") === undefined ? undefined : issueNumber(args);
      return refusable(async () => {
        await deps.markIssuesSeen(project.id, number);
        return { result: { seen: number ?? "all" } };
      });
    },

    "issues-open": (args, caller) => {
      const { ref } = refFrom(args, caller);
      const number = issueNumber(args);
      const keep = args.keep === true;
      deps.openIssue(ref, number, keep, args.background === true);
      return { result: { opened: number, keep } };
    },

    "issues-open-in-agent": async (args, caller) => {
      const { ref } = refFrom(args, caller);
      const number = issueNumber(args);
      const agent = openableAgent(deps, args, caller);
      if (!agent.terminal) {
        throw new ControlError("bad_args", `a ${agent.id} tab takes no issue`);
      }
      const opened = await deps.openIssueInAgent(ref, number, agent.id, caller.side.holdsTabs);
      if (!opened.ok) {
        throw new ControlError("bad_args", opened.error);
      }
      bringToFront(deps, args, ref, opened.tab.tabId);
      return { result: opened.tab };
    },
  };
}
