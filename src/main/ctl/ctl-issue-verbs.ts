import * as path from "node:path";
import type { ControlVerbName } from "../../shared/ctl";
import { ISSUE_STATE_FILTERS, type IssueFilter } from "../../shared/types/providers";
import { notOpenMessage } from "../store/resolved-ref";
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
  type Handler,
  type OwnedTab,
  type RefFrom,
} from "./ctl-verb";

/** The Issues section's filter as `issues-list` words it: the open issues, until `--state` says more. */
function issueFilter(args: Record<string, unknown>): IssueFilter {
  const state = args.state === undefined ? "open" : oneOf(args, "state", "state", ISSUE_STATE_FILTERS);
  const author = optionalText(args, "author");
  const assignee = optionalText(args, "assignee");
  return {
    ...(state === "all" ? {} : { state }),
    ...(author === undefined ? {} : { author }),
    ...(assignee === undefined ? {} : { assignee }),
    labels: labelsArg(args),
  };
}

/**
 * The issue verbs: those a change request has too (`trackedVerbs`), and the tracker's own. The tracker
 * is the project's, so the verbs asking it act on the project of the repository or worktree `refFrom`
 * finds (resolveCallerRef), whichever of them that is.
 */
export function issueVerbs(
  deps: ControlDeps,
  refFrom: RefFrom,
  ownedTab: OwnedTab,
): Record<Extract<ControlVerbName, `issues-${string}`>, Handler> {
  const shared = trackedVerbs("issue", deps, refFrom, ownedTab);
  const issueNumber = (args: Record<string, unknown>): number => numberArg(args, "issue");

  return {
    "issues-read": shared.read,
    "issues-mark-seen": shared["mark-seen"],
    "issues-field-options": shared["field-options"],
    "issues-set-field": shared["set-field"],
    "issues-update": shared.update,
    "issues-edit-comment": shared["edit-comment"],
    "issues-delete-comment": shared["delete-comment"],
    "issues-open": shared.open,
    "issues-send-to-agent": shared["send-to-agent"],
    "issues-link-session": shared["link-session"],
    "issues-unlink-session": shared["unlink-session"],
    "issues-session": shared.session,

    "issues-set-source": (args, caller) => {
      const { project } = refFrom(args, caller);
      const source = optionalText(args, "source") ?? "";
      return refusable(async () => ({ result: { source: (await deps.issues.setSource(project.id, source)) ?? null } }));
    },

    "issues-get-source": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => ({ result: await deps.issues.tracker(project.id) }));
    },

    "issues-unread": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => {
        const unread = await deps.issues.unread(project.id);
        return { result: unread.map(({ number, title, url, updatedAt }) => ({ number, title, url, updatedAt })) };
      });
    },

    "issues-list": (args, caller) => {
      const { project } = refFrom(args, caller);
      const filter = issueFilter(args);
      return refusable(async () => {
        const issues = await deps.issues.list(project.id, filter);
        return { result: issues.map(withoutAvatars) };
      });
    },

    "issues-latest": (args, caller) => {
      const { project } = refFrom(args, caller);
      const filter = issueFilter(args);
      return refusable(async () => ({ result: await deps.issues.latest(project.id, filter) }));
    },

    "issues-filter-options": (args, caller) => {
      const { project } = refFrom(args, caller);
      return refusable(async () => ({ result: await deps.issues.filterOptions(project.id) }));
    },

    "issues-image": (args, caller) => {
      const { project } = refFrom(args, caller);
      const source = text(args, "source", "image address");
      return refusable(async () => ({ result: { dataUrl: await deps.tracked.issue.image(project.id, source) } }));
    },

    "issues-create": (args, caller) => {
      const { project } = refFrom(args, caller);
      const title = text(args, "title", "title");
      const body = optionalText(args, "body") ?? "";
      return refusable(async () => ({ result: { created: await deps.issues.create(project.id, title, body, false) } }));
    },

    "issues-delete": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      if (args.confirm !== true) {
        throw new ControlError("bad_args", `deleting #${number} removes it from the tracker for good. Ask the user, then pass --confirm.`);
      }
      return refusable(async () => {
        await deps.issues.delete(project.id, number);
        return { result: { deleted: number } };
      });
    },

    "issues-comment": (args, caller) => {
      const { project } = refFrom(args, caller);
      const number = issueNumber(args);
      const body = text(args, "body", "comment text");
      const internal = args.internal === true;
      return refusable(async () => {
        await deps.tracked.issue.comment(project.id, number, body, internal);
        return { result: { commented: number, internal } };
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
        const markdown = await deps.issues.upload(project.id, path.basename(file), await caller.side.readFile(root, file));
        return { result: { markdown } };
      });
    },
  };
}
