import { ISSUE_STATES, type IssueChange, type IssueDetail, type IssueFieldValue, type TrackedKind } from "../../shared/types/providers";
import {
  bringToFront,
  ControlError,
  list,
  numberArg,
  oneOf,
  openableAgent,
  optionalText,
  refusable,
  text,
  withoutAvatars,
  type ControlDeps,
  type Handler,
  type OwnedTab,
  type RefFrom,
} from "./ctl-verb";

/** How the verbs of a kind word it: what one is, where it lives, and what its verbs start with. */
const WORDS: Record<TrackedKind, { noun: string; host: string; verbs: string }> = {
  issue: { noun: "issue", host: "tracker", verbs: "issues" },
  "change-request": { noun: "pull or merge request", host: "host", verbs: "change-requests" },
};

/**
 * What `*-set-field` sets the field to, as its kind takes it (`IssueFieldValue`): the values given,
 * or none for a pick to empty and for the rest to take it off.
 */
function fieldValue(detail: IssueDetail, fieldId: string, args: Record<string, unknown>, missing: string): IssueFieldValue {
  const field = detail.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    throw new ControlError("bad_args", missing);
  }
  if (!field.editable) {
    throw new ControlError("bad_args", `the field ${field.name} cannot be changed`);
  }
  const values = list(args, "value");
  const single = (): string | null => {
    if (values.length > 1) {
      throw new ControlError("bad_args", `the field ${field.name} takes one value`);
    }
    return values[0] ?? null;
  };
  switch (field.kind) {
    case "pick":
      if (values.length > 1 && !field.several) {
        throw new ControlError("bad_args", `the field ${field.name} takes one value`);
      }
      return values;
    case "text":
    case "date":
    case "duration":
      return single();
    case "number": {
      const typed = single();
      const number = typed === null ? null : Number(typed);
      if (number !== null && !Number.isFinite(number)) {
        throw new ControlError("bad_args", `not a number: ${typed}`);
      }
      return number;
    }
    case "flag": {
      const typed = single();
      if (typed !== "on" && typed !== "off") {
        throw new ControlError("bad_args", `the field ${field.name} takes on or off`);
      }
      return typed === "on";
    }
    case "timelog": {
      const remove = optionalText(args, "remove");
      if (remove !== undefined) {
        return { remove };
      }
      const timeSpent = single();
      if (timeSpent === null) {
        throw new ControlError("bad_args", `the field ${field.name} takes the time spent, or --remove <id of a booking>`);
      }
      const spentAt = optionalText(args, "date");
      const summary = optionalText(args, "summary");
      return {
        timeSpent,
        ...(spentAt === undefined ? {} : { spentAt }),
        ...(summary === undefined ? {} : { summary }),
      };
    }
  }
}

/**
 * The verbs issues and change requests share, as `issues-*` and `change-requests-*` name them: the host
 * is the project's, so the verbs asking it act on the project of the repository or worktree `refFrom`
 * finds (resolveCallerRef), whichever of them that is; those linking a session act on a tab there
 * (`ownedTab`).
 */
export function trackedVerbs(kind: TrackedKind, deps: ControlDeps, refFrom: RefFrom, ownedTab: OwnedTab) {
  const { noun, host, verbs } = WORDS[kind];
  const ops = deps.tracked[kind];
  const numberOf = (args: Record<string, unknown>): number => numberArg(args, noun);

  return {
    read: ((args, caller) => {
      const { project } = refFrom(args, caller);
      const number = numberOf(args);
      return refusable(async () => ({ result: withoutAvatars((await ops.read(project.id, number)).detail) }));
    }) satisfies Handler,

    "mark-seen": ((args, caller) => {
      const { project } = refFrom(args, caller);
      const number = optionalText(args, "number") === undefined ? undefined : numberOf(args);
      return refusable(async () => {
        await ops.markSeen(project.id, number);
        return { result: { seen: number ?? "all" } };
      });
    }) satisfies Handler,

    "field-options": ((args, caller) => {
      const { project } = refFrom(args, caller);
      const number = numberOf(args);
      const fieldId = text(args, "field", "field");
      return refusable(async () => ({ result: { options: await ops.fieldOptions(project.id, number, fieldId) } }));
    }) satisfies Handler,

    "set-field": ((args, caller) => {
      const { project } = refFrom(args, caller);
      const number = numberOf(args);
      const fieldId = text(args, "field", "field");
      return refusable(async () => {
        const missing = `${ops.nameOf(number)} has no field ${fieldId} (see ${verbs}-read)`;
        const value = fieldValue((await ops.read(project.id, number)).detail, fieldId, args, missing);
        await ops.setField(project.id, number, fieldId, value);
        return { result: { set: fieldId, value } };
      });
    }) satisfies Handler,

    update: ((args, caller) => {
      const { project } = refFrom(args, caller);
      const number = numberOf(args);
      const title = optionalText(args, "title");
      const state = args.state === undefined ? undefined : oneOf(args, "state", "state", ISSUE_STATES);
      const change: IssueChange = {
        ...(title === undefined ? {} : { title }),
        // Empty is a text too: it empties its own.
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(state === undefined ? {} : { state }),
      };
      if (Object.keys(change).length === 0) {
        throw new ControlError("bad_args", "nothing to change: pass --title, --body or --state");
      }
      return refusable(async () => {
        await ops.update(project.id, number, change);
        return { result: { updated: number } };
      });
    }) satisfies Handler,

    "edit-comment": ((args, caller) => {
      const { project } = refFrom(args, caller);
      const id = text(args, "commentId", "comment id");
      const body = text(args, "body", "comment text");
      return refusable(async () => {
        await ops.editComment(project.id, id, body);
        return { result: { edited: id } };
      });
    }) satisfies Handler,

    "delete-comment": ((args, caller) => {
      const { project } = refFrom(args, caller);
      const id = text(args, "commentId", "comment id");
      if (args.confirm !== true) {
        throw new ControlError("bad_args", `deleting a comment removes it from the ${host} for good. Ask the user, then pass --confirm.`);
      }
      return refusable(async () => {
        await ops.deleteComment(project.id, id);
        return { result: { deleted: id } };
      });
    }) satisfies Handler,

    open: ((args, caller) => {
      const { ref } = refFrom(args, caller);
      const number = numberOf(args);
      const keep = args.keep === true;
      deps.openTracked(ref, { kind, number }, keep, args.background === true);
      return { result: { opened: number, keep } };
    }) satisfies Handler,

    "send-to-agent": (async (args, caller) => {
      const { ref } = refFrom(args, caller);
      const number = numberOf(args);
      const agent = openableAgent(deps, args, caller);
      if (!agent.terminal) {
        throw new ControlError("bad_args", `a ${agent.id} tab takes no ${noun}`);
      }
      const opened = await deps.sendTrackedToAgent(ref, { kind, number }, agent.id, caller.side.holdsTabs);
      if (!opened.ok) {
        throw new ControlError("bad_args", opened.error);
      }
      bringToFront(deps, args, ref, opened.tab.tabId);
      return { result: opened.tab };
    }) satisfies Handler,

    "link-session": ((args, caller) => {
      const number = numberOf(args);
      const { tabs, tabId } = ownedTab(args, caller);
      const linked = tabs.link(tabId, { kind, number });
      if (!linked.ok) {
        throw new ControlError("bad_args", linked.error);
      }
      // Undefined fields are left out of the JSON answer.
      return { result: { linked: number, tabId, movedFrom: linked.movedFrom, replacedSession: linked.replacedSession } };
    }) satisfies Handler,

    "unlink-session": ((args, caller) => {
      const number = numberOf(args);
      const { tabs, tabId } = ownedTab(args, caller);
      const unlinked = tabs.unlink(tabId, { kind, number });
      if (!unlinked.ok) {
        throw new ControlError("bad_args", unlinked.error);
      }
      return { result: { unlinked: number, tabId } };
    }) satisfies Handler,

    session: ((args, caller) => {
      const { project } = refFrom(args, caller);
      const session = deps.trackedSession(project.id, { kind, number: numberOf(args) });
      if (!session) {
        return { result: null };
      }
      const { worktree, tabId, agentId, title, archived } = session;
      return { result: { ...(worktree !== undefined && { worktree }), tabId, agentId, title, archived } };
    }) satisfies Handler,
  };
}
