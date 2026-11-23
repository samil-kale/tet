import { Fragment } from "react";
import {
  type TrackedDetail,
  type ChangeRequestDetail,
  isChangeRequest,
  titleCased,
  type TrackedRef,
  changeRequestName,
} from "../../../shared/types/providers";

export const DAY_MS = 86_400_000;

/** The day of a time, counted from today where that says more than the date. */
export function dayOf(at: string): string {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / DAY_MS);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : new Date(at).toLocaleDateString();
}

/** The longest unit first: a time is counted in the first it fills. */
export const ELAPSED_UNITS = [
  ["week", 7 * DAY_MS],
  ["day", DAY_MS],
  ["hour", 3_600_000],
  ["minute", 60_000],
] as const;

export const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** When something was written, worded as GitHub does: how long ago for 30 days, then its date, with
 *  the year where it is not this one. */
export function agoOf(at: string): string {
  const date = new Date(at);
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 30 * DAY_MS) {
    const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
    return `on ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year })}`;
  }
  const filled = ELAPSED_UNITS.find(([, ms]) => elapsed >= ms);
  return filled ? RELATIVE_TIME.format(-Math.floor(elapsed / filled[1]), filled[0]) : "now";
}

/** The change request a tab shows, where it shows one rather than an issue. */
export function changeRequestOf(issue: TrackedDetail): ChangeRequestDetail | undefined {
  return isChangeRequest(issue) ? issue : undefined;
}

/** What the tab calls what it shows, in a title's case: "Issue", or the host's own word for a change
 *  request, "Pull Request" or "Merge Request". */
export function trackedNoun(issue: TrackedDetail): string {
  const request = changeRequestOf(issue);
  return request ? titleCased(request.kind.noun) : "Issue";
}

export function trackedRefOf(issue: TrackedDetail): TrackedRef {
  return { kind: isChangeRequest(issue) ? "change-request" : "issue", number: issue.number };
}

/** How the tab names it: `#142`, `!42`. */
export function numberOf(issue: TrackedDetail): string {
  const request = changeRequestOf(issue);
  return request ? changeRequestName(request.kind, request.number) : `#${issue.number}`;
}

/** Items as a sentence lists them, each set apart by `show`, the last joined by `joiner`. */
export function listed<T = string>(items: T[], show: (item: T) => React.ReactNode, joiner = "and"): React.ReactNode {
  return items.map((item, index) => (
    <Fragment key={index}>
      {index > 0 && (index === items.length - 1 ? ` ${joiner} ` : ", ")}
      {show(item)}
    </Fragment>
  ));
}

export function login(name: string): React.ReactNode {
  return <span className="tracked-event-name">{name}</span>;
}

export function label(name: string): React.ReactNode {
  return <span className="label-pill">{name}</span>;
}

/** Where it stands, as the bar says it: open or closed, a change request also draft or merged. */
export function stateOf(issue: TrackedDetail): string {
  const request = changeRequestOf(issue);
  if (request?.state === "merged") {
    return "Merged";
  }
  if (!issue.open) {
    return "Closed";
  }
  return request?.draft ? "Draft" : "Open";
}
