import * as path from "node:path";
import type { ControlVerbName } from "../../shared/ctl";
import {
  ISSUE_STATE_FILTERS,
  ISSUE_STATES,
  type IssueChange,
  type IssueDetail,
  type IssueFieldValue,
  type IssueFilter,
} from "../../shared/types/providers";
import { notOpenMessage } from "../store/resolved-ref";
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

/** An issue as the CLI answers it: the pictures of the people it names belong to the section. */
function withoutAvatars<T extends object>(issue: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(issue).filter(([key]) => key !== "avatars"));
}

/** The ISSUES section's filter as `issues-list` words it: the open issues, until `--state` says more. */
function issueFilter(args: Record<string, unknown>): IssueFilter {
  const state = args.state === undefined ? "open" : oneOf(args, "state", "state", ISSUE_STATE_FILTERS);
  const author = optionalText(args, "author");
  const assignee = optionalText(args, "assignee");
  return {
    ...(state === "all" ? {} : { state }),
    ...(author === undefined ? {} : { author }),
    ...(assignee === undefined ? {} : { assignee }),
    labels: (optionalText(args, "label") ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label !== ""),
  };
}

/**
 * What `issues-set-field` sets the field to, as its kind takes it (`IssueFieldValue`): the values
 * given, or none for a pick to empty and for the rest to take it off.
 */
function fieldValue(issue: IssueDetail, fieldId: string, args: Record<string, unknown>): IssueFieldValue {
  const field = issue.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    throw new ControlError("bad_args", `issue #${issue.number} has no field ${fieldId} (see issues-read)`);
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
 * The issue verbs. The tracker is the project's, so the verbs asking it act on the project of the
 * repository or worktree `refFrom` finds (resolveCallerRef), whichever of them that is; those linking
 * a session act on a tab there (`ownedTab`).
 */
export function issueVerbs(
  deps: ControlDeps,
  refFrom: RefFrom,
  ownedTab: OwnedTab,
): Record<Extract<ControlVerbName, `issues-${string}`>, Handler> {
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

    "issues-list": (args, caller) => {
      const { project } = refFrom(args, caller);
      const filter = issueFilter(args);
      return refusable(async () => {
        const issues = await deps.listIssues(project.id, filter);
        return { result: issues.map(withoutAvatars) };
      });
    },

    "issues-latest": (args, caller) => {
      const { project } = refFrom(args, caller);
      const filter = issueFilter(args);
      return refusable(async () => ({ result: await deps.latestIssues(project.id, filter) }));
    },

    "issues-filter-options": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => ({ result: await deps.issueFilterOptions(project.id) }));
    },

    "issues-read": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      return refusable(async () => ({ result: withoutAvatars(await deps.readIssue(project.id, number)) }));
    },

    "issues-image": (args, caller) => {
      const { project } = refFrom(args, caller);
      const source = text(args, "source", "image address");
      return refusable(async () => ({ result: { dataUrl: await deps.issueImage(project.id, source) } }));
    },

    "issues-field-options": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      const fieldId = text(args, "field", "field");
      return refusable(async () => ({ result: { options: await deps.issueFieldOptions(project.id, number, fieldId) } }));
    },

    "issues-set-field": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      const fieldId = text(args, "field", "field");
      return refusable(async () => {
        const value = fieldValue(await deps.readIssue(project.id, number), fieldId, args);
        await deps.setIssueField(project.id, number, fieldId, value);
        return { result: { set: fieldId, value } };
      });
    },

    "issues-create": (args, caller) => {
      const { project } = refFrom(args, caller);
      const title = text(args, "title", "title");
      const body = optionalText(args, "body") ?? "";
      return refusable(async () => ({ result: { created: await deps.createIssue(project.id, title, body) } }));
    },

    "issues-update": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      const title = optionalText(args, "title");
      const state = args.state === undefined ? undefined : oneOf(args, "state", "state", ISSUE_STATES);
      const change: IssueChange = {
        ...(title === undefined ? {} : { title }),
        // Empty is a text too: it empties the issue's.
        ...(typeof args.body === "string" ? { body: args.body } : {}),
        ...(state === undefined ? {} : { state }),
      };
      if (Object.keys(change).length === 0) {
        throw new ControlError("bad_args", "nothing to change: pass --title, --body or --state");
      }
      return refusable(async () => {
        await deps.updateIssue(project.id, number, change);
        return { result: { updated: number } };
      });
    },

    "issues-delete": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      if (args.confirm !== true) {
        throw new ControlError("bad_args", `deleting #${number} removes it from the tracker for good. Ask the user, then pass --confirm.`);
      }
      return refusable(async () => {
        await deps.deleteIssue(project.id, number);
        return { result: { deleted: number } };
      });
    },

    "issues-comment": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      const body = text(args, "body", "comment text");
      const internal = args.internal === true;
      return refusable(async () => {
        await deps.commentIssue(project.id, number, body, internal);
        return { result: { commented: number, internal } };
      });
    },

    "issues-edit-comment": (args, caller) => {
      const { project } = refFrom(args, caller);
      const id = text(args, "commentId", "comment id");
      const body = text(args, "body", "comment text");
      return refusable(async () => {
        await deps.editIssueComment(project.id, id, body);
        return { result: { edited: id } };
      });
    },

    "issues-delete-comment": (args, caller) => {
      const { project } = refFrom(args, caller);
      const id = text(args, "commentId", "comment id");
      if (args.confirm !== true) {
        throw new ControlError("bad_args", "deleting a comment removes it from the tracker for good. Ask the user, then pass --confirm.");
      }
      return refusable(async () => {
        await deps.deleteIssueComment(project.id, id);
        return { result: { deleted: id } };
      });
    },

    "issues-upload": (args, caller) => {
      const { project, ref } = refFrom(args, caller);
      const root = deps.projectRefPath(ref);
      if (root === undefined) {
        throw new ControlError("not_found", notOpenMessage(deps.store, ref));
      }
      const file = path.resolve(root, text(args, "path", "path"));
      return refusable(async () => {
        const markdown = await deps.uploadIssueFile(project.id, path.basename(file), await caller.side.readFile(root, file));
        return { result: { markdown } };
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

    "issues-link-session": (args, caller) => {
      const number = issueNumber(args);
      const { tabs, tabId } = ownedTab(args, caller);
      const linked = tabs.linkIssue(tabId, number);
      if (!linked.ok) {
        throw new ControlError("bad_args", linked.error);
      }
      return { result: { linked: number, tabId } };
    },

    "issues-unlink-session": (args, caller) => {
      const number = issueNumber(args);
      const { tabs, tabId } = ownedTab(args, caller);
      const unlinked = tabs.unlinkIssue(tabId, number);
      if (!unlinked.ok) {
        throw new ControlError("bad_args", unlinked.error);
      }
      return { result: { unlinked: number, tabId } };
    },

    "issues-sessions": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      return {
        result: deps.issueSessions(project.id, number).map(({ worktree, tabId, agentId, title, archived }) => ({
          ...(worktree !== undefined && { worktree }),
          tabId,
          agentId,
          title,
          archived,
        })),
      };
    },
  };
}
