import type { ControlVerbName } from "../../shared/ctl";
import {
  CHANGE_REQUEST_STATE_FILTERS,
  ISSUE_STATES,
  type ChangeRequestDetail,
  type ChangeRequestFilter,
  type IssueChange,
  type IssueFieldValue,
} from "../../shared/types/providers";
import {
  bringToFront,
  ControlError,
  list,
  oneOf,
  openableAgent,
  optionalText,
  positiveInteger,
  refusable,
  text,
  type ControlDeps,
  type Handler,
  type OwnedTab,
  type RefFrom,
} from "./ctl-verb";

/** A change request as the CLI answers it: the pictures of the people it names belong to the section. */
function withoutAvatars<T extends object>(row: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "avatars"));
}

/** The section's filter as `change-requests-list` words it: the open ones, until `--state` says more. */
function changeRequestFilter(args: Record<string, unknown>): ChangeRequestFilter {
  const state = args.state === undefined ? "open" : oneOf(args, "state", "state", CHANGE_REQUEST_STATE_FILTERS);
  const author = optionalText(args, "author");
  const assignee = optionalText(args, "assignee");
  const reviewer = optionalText(args, "reviewer");
  return {
    ...(state === "all" ? {} : { state }),
    ...(author === undefined ? {} : { author }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(reviewer === undefined ? {} : { reviewer }),
    labels: (optionalText(args, "label") ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label !== ""),
  };
}

/** What `change-requests-set-field` sets a pick field to: the values given, none emptying it. */
function fieldValue(request: ChangeRequestDetail, fieldId: string, args: Record<string, unknown>): IssueFieldValue {
  const field = request.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    throw new ControlError("bad_args", `${request.kind.prefix}${request.number} has no field ${fieldId} (see change-requests-read)`);
  }
  if (!field.editable || field.kind !== "pick") {
    throw new ControlError("bad_args", `the field ${field.name} cannot be changed`);
  }
  const values = list(args, "value");
  if (values.length > 1 && !field.several) {
    throw new ControlError("bad_args", `the field ${field.name} takes one value`);
  }
  return values;
}

/**
 * The change request verbs, as the issue verbs (ctl-issue-verbs.ts): the host is the project's, so the
 * verbs asking it act on the project of the repository or worktree `refFrom` finds; those linking a
 * session act on a tab there (`ownedTab`).
 */
export function changeRequestVerbs(
  deps: ControlDeps,
  refFrom: RefFrom,
  ownedTab: OwnedTab,
): Record<Extract<ControlVerbName, `change-requests-${string}`>, Handler> {
  /** The first positional, a change request's number. */
  const requestNumber = (args: Record<string, unknown>): number => {
    const typed = text(args, "number", "number");
    const number = positiveInteger(typed);
    if (number === undefined) {
      throw new ControlError("bad_args", `not a pull or merge request number: ${typed}`);
    }
    return number;
  };

  return {
    "change-requests-list": (args, caller) => {
      const { project } = refFrom(args, caller);
      const filter = changeRequestFilter(args);
      return refusable(async () => ({ result: (await deps.listChangeRequests(project.id, filter)).map(withoutAvatars) }));
    },

    "change-requests-latest": (args, caller) => {
      const { project } = refFrom(args, caller);
      const filter = changeRequestFilter(args);
      return refusable(async () => ({ result: await deps.latestChangeRequests(project.id, filter) }));
    },

    "change-requests-filter-options": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => ({ result: await deps.changeRequestFilterOptions(project.id) }));
    },

    "change-requests-read": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      return refusable(async () => ({ result: withoutAvatars(await deps.readChangeRequest(project.id, number)) }));
    },

    "change-requests-unread": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => {
        const unread = await deps.unreadChangeRequests(project.id);
        return { result: unread.map(({ number, title, url, updatedAt, checks }) => ({ number, title, url, updatedAt, checks })) };
      });
    },

    "change-requests-mark-seen": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = optionalText(args, "number") === undefined ? undefined : requestNumber(args);
      return refusable(async () => {
        await deps.markChangeRequestsSeen(project.id, number);
        return { result: { seen: number ?? "all" } };
      });
    },

    "change-requests-field-options": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      const fieldId = text(args, "field", "field");
      return refusable(async () => ({ result: { options: await deps.changeRequestFieldOptions(project.id, number, fieldId) } }));
    },

    "change-requests-set-field": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      const fieldId = text(args, "field", "field");
      return refusable(async () => {
        const value = fieldValue(await deps.readChangeRequest(project.id, number), fieldId, args);
        await deps.setChangeRequestField(project.id, number, fieldId, value);
        return { result: { set: fieldId, value } };
      });
    },

    "change-requests-update": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      const title = optionalText(args, "title");
      const state = args.state === undefined ? undefined : oneOf(args, "state", "state", ISSUE_STATES);
      const change: IssueChange = {
        ...(title === undefined ? {} : { title }),
        // Empty is a text too: it empties the change request's.
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(state === undefined ? {} : { state }),
      };
      if (Object.keys(change).length === 0) {
        throw new ControlError("bad_args", "nothing to change: pass --title, --body or --state");
      }
      return refusable(async () => {
        await deps.updateChangeRequest(project.id, number, change);
        return { result: { updated: number } };
      });
    },

    "change-requests-comment": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      const body = text(args, "body", "comment text");
      return refusable(async () => {
        await deps.commentChangeRequest(project.id, number, body);
        return { result: { commented: number } };
      });
    },

    "change-requests-edit-comment": (args, caller) => {
      const { project } = refFrom(args, caller);
      const id = text(args, "commentId", "comment id");
      const body = text(args, "body", "comment text");
      return refusable(async () => {
        await deps.editChangeRequestComment(project.id, id, body);
        return { result: { edited: id } };
      });
    },

    "change-requests-delete-comment": (args, caller) => {
      const { project } = refFrom(args, caller);
      const id = text(args, "commentId", "comment id");
      if (args.confirm !== true) {
        throw new ControlError("bad_args", "deleting a comment removes it from the host for good. Ask the user, then pass --confirm.");
      }
      return refusable(async () => {
        await deps.deleteChangeRequestComment(project.id, id);
        return { result: { deleted: id } };
      });
    },

    "change-requests-approve": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      return refusable(async () => {
        await deps.approveChangeRequest(project.id, number);
        return { result: { approved: number } };
      });
    },

    "change-requests-merge": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      const auto = args.auto === true;
      if (args.confirm !== true) {
        throw new ControlError("bad_args", `merging ${number} is not taken back. Ask the user, then pass --confirm.`);
      }
      return refusable(async () => {
        await deps.mergeChangeRequest(project.id, number, auto);
        return { result: auto ? { autoMerge: number } : { merged: number } };
      });
    },

    "change-requests-open": (args, caller) => {
      const { ref } = refFrom(args, caller);
      const number = requestNumber(args);
      const keep = args.keep === true;
      deps.openChangeRequest(ref, number, keep, args.background === true);
      return { result: { opened: number, keep } };
    },

    "change-requests-send-to-agent": async (args, caller) => {
      const { ref } = refFrom(args, caller);
      const number = requestNumber(args);
      const agent = openableAgent(deps, args, caller);
      if (!agent.terminal) {
        throw new ControlError("bad_args", `a ${agent.id} tab takes no pull or merge request`);
      }
      const opened = await deps.sendChangeRequestToAgent(ref, number, agent.id, caller.side.holdsTabs);
      if (!opened.ok) {
        throw new ControlError("bad_args", opened.error);
      }
      bringToFront(deps, args, ref, opened.tab.tabId);
      return { result: opened.tab };
    },

    "change-requests-link-session": (args, caller) => {
      const number = requestNumber(args);
      const { tabs, tabId } = ownedTab(args, caller);
      const linked = tabs.linkChangeRequest(tabId, number);
      if (!linked.ok) {
        throw new ControlError("bad_args", linked.error);
      }
      // Undefined fields are left out of the JSON answer.
      return { result: { linked: number, tabId, movedFrom: linked.movedFrom, replacedSession: linked.replacedSession } };
    },

    "change-requests-unlink-session": (args, caller) => {
      const number = requestNumber(args);
      const { tabs, tabId } = ownedTab(args, caller);
      const unlinked = tabs.unlinkChangeRequest(tabId, number);
      if (!unlinked.ok) {
        throw new ControlError("bad_args", unlinked.error);
      }
      return { result: { unlinked: number, tabId } };
    },

    "change-requests-session": (args, caller) => {
      const { project } = refFrom(args, caller);
      const session = deps.changeRequestSession(project.id, requestNumber(args));
      if (!session) {
        return { result: null };
      }
      const { worktree, tabId, agentId, title, archived } = session;
      return { result: { ...(worktree !== undefined && { worktree }), tabId, agentId, title, archived } };
    },
  };
}
