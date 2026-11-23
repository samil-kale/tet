import { CHANGE_REQUEST_STATE_FILTERS, type ChangeRequestFilter } from "../../shared/types/providers";
import { trackedVerbs } from "./ctl-tracked-verbs";
import {
  ControlError,
  labelsArg,
  numberArg,
  oneOf,
  optionalText,
  refusable,
  text,
  withoutAvatars,
  type ControlDeps,
  type HandlersOf,
  type OwnedTab,
  type RefFrom,
} from "./ctl-verb";

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
    labels: labelsArg(args),
  };
}

/**
 * The change request verbs: those an issue has too (`trackedVerbs`), and the host's own, as the issue
 * verbs (ctl-issue-verbs.ts).
 */
export function changeRequestVerbs(deps: ControlDeps, refFrom: RefFrom, ownedTab: OwnedTab): HandlersOf<"change-requests-"> {
  const shared = trackedVerbs("change-request", deps, refFrom, ownedTab);
  const requestNumber = (args: Record<string, unknown>): number => numberArg(args, "pull or merge request");

  return {
    "change-requests-read": shared.read,
    "change-requests-mark-seen": shared["mark-seen"],
    "change-requests-field-options": shared["field-options"],
    "change-requests-set-field": shared["set-field"],
    "change-requests-update": shared.update,
    "change-requests-edit-comment": shared["edit-comment"],
    "change-requests-delete-comment": shared["delete-comment"],
    "change-requests-open": shared.open,
    "change-requests-send-to-agent": shared["send-to-agent"],
    "change-requests-link-session": shared["link-session"],
    "change-requests-unlink-session": shared["unlink-session"],
    "change-requests-session": shared.session,

    "change-requests-list": (args, caller) => {
      const { project } = refFrom(args, caller);
      const filter = changeRequestFilter(args);
      return refusable(async () => ({ result: (await deps.changeRequests.list(project.id, filter)).map(withoutAvatars) }));
    },

    "change-requests-latest": (args, caller) => {
      const { project } = refFrom(args, caller);
      const filter = changeRequestFilter(args);
      return refusable(async () => ({ result: await deps.changeRequests.latest(project.id, filter) }));
    },

    "change-requests-filter-options": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => ({ result: await deps.changeRequests.filterOptions(project.id) }));
    },

    "change-requests-unread": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => {
        const unread = await deps.changeRequests.unread(project.id);
        return { result: unread.map(({ number, title, url, updatedAt, checks }) => ({ number, title, url, updatedAt, checks })) };
      });
    },

    "change-requests-comment": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      const body = text(args, "body", "comment text");
      return refusable(async () => {
        await deps.tracked["change-request"].comment(project.id, number, body, false);
        return { result: { commented: number } };
      });
    },

    "change-requests-approve": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = requestNumber(args);
      return refusable(async () => {
        await deps.changeRequests.approve(project.id, number);
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
        await deps.changeRequests.merge(project.id, number, auto);
        return { result: auto ? { autoMerge: number } : { merged: number } };
      });
    },
  };
}
