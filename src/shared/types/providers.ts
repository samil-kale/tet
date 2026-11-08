import type { ActionDone, ActionRefused } from "./action";

export type ProviderId = "github" | "gitlab";

/** A repository host account. Its token is kept encrypted, main-side. */
export interface ProviderAccount {
  id: string;
  provider: ProviderId;
  /** "github.com", or a self-hosted instance. */
  host: string;
  /** The token's login, read from the API when added. */
  user: string;
  /** The group the list was last narrowed to; "" is all, undefined never picked. */
  namespace?: string;
}

/** A repository the remote tab lists. */
export interface RemoteRepository {
  /** "owner/name". */
  fullName: string;
  /** The clone tab's default folder name. */
  name: string;
  /** The https url; the account's token can authenticate it. */
  cloneUrl: string;
}

/** The account once its token checked out, or the API's message. */
export type AddAccountResult = (ActionDone & { account: ProviderAccount }) | ActionRefused;

export interface ListRepositoriesResult {
  repos?: RemoteRepository[];
  error?: string;
}

/** A row of the ISSUES section. */
export interface Issue {
  /** GitHub's `number`, GitLab's `iid`: what the host's pages call it. */
  number: number;
  title: string;
  url: string;
  open: boolean;
  author: string;
  /** The first of them; a row has room for one. */
  assignee?: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. Of its last change on the tracker: a tab that read it earlier is out of date. */
  updatedAt: string;
  labels: string[];
  /** The picture of whom it names, by login, where the host has one. */
  avatars: Record<string, string>;
}

/** What the host narrows the ISSUES section to; a field left out narrows nothing. */
export interface IssueFilter {
  state?: "open" | "closed";
  author?: string;
  assignee?: string;
  /** An issue has to carry all of them. */
  labels: string[];
}

/** What the tracker says of a list of issues without sending it: how many it holds and when the most
 *  recently changed one changed. Two reads that agree found nothing new in it. */
export interface IssuesLatest {
  total: number;
  /** ISO 8601; absent for an empty list. */
  updatedAt?: string;
}

export interface IssueListResult {
  issues?: Issue[];
  /** Read just before `issues`, so that a change made while the list came is found by the next read. */
  latest?: IssuesLatest;
  /** The `issues` of the project's tet.json, where it has one. */
  source?: string;
  error?: string;
  /** `error` is that no account is added for the repository's tracker. */
  noAccount?: boolean;
}

export interface IssueLatestResult {
  latest?: IssuesLatest;
  error?: string;
}

/** What the ISSUES section's filters offer. */
export interface IssueFilterOptions {
  labels?: string[];
  /** Offered for both author and assignee. */
  people?: string[];
  error?: string;
}

/** A comment of an issue, oldest first in `IssueDetail.notes`. */
export interface IssueNote {
  /** What the tracker addresses it by, its GraphQL id. */
  id: string;
  author: string;
  /** ISO 8601. */
  createdAt: string;
  body: string;
  /** Visible to the project's members alone; absent where the tracker has no such comments. */
  internal?: boolean;
}

/** What happened to an issue, shown between its comments. */
export type IssueEvent = { actor: string; /** ISO 8601. */ createdAt: string } & (
  | { kind: "closed" | "reopened" }
  | { kind: "assigned" | "unassigned"; login: string }
  | { kind: "labeled" | "unlabeled"; label: string }
  | { kind: "milestoned" | "demilestoned"; milestone: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "linked"; number: number; title: string; url: string }
  /** As the tracker worded it, where it says no more than that. */
  | { kind: "text"; text: string }
);

/**
 * One field of an issue, as the tab's side column lists them: what the tracker keeps of an issue
 * beside its text and comments, in the tracker's own words and order. A field the tracker does not
 * have for this issue (its type or plan lacks it) is not listed.
 */
export type IssueField = {
  /** What the provider addresses it by in `listOptions` and `setField`. */
  id: string;
  name: string;
  /** Whether the tracker takes a change of it; its rights can still refuse one. */
  editable: boolean;
  /** Fields of one group are one section, titled by it, at the place of the first; only typed ones
   *  (text, number, date, duration, timelog) go in one, as the section's one button asks for them. */
  group?: string;
} & (
  | {
      kind: "pick";
      /** What it names, each as `listOptions` lists it. */
      value: string[];
      several: boolean;
      /** How its values are drawn: as labels, as labels of people, whose field offers the viewer to add
       *  themselves, or as plain text. */
      shown: "text" | "people" | "labels";
    }
  | { kind: "text"; value?: string }
  | { kind: "number"; value?: number }
  | { kind: "date"; /** YYYY-MM-DD. */ value?: string }
  | { kind: "duration"; /** As the tracker words it, "1h 30m". */ value?: string }
  /** Time booked to the issue: `value` is the total, `entries` the bookings, newest first; `setField`
   *  takes a new entry, or the removal of one. */
  | { kind: "timelog"; value?: string; entries: IssueTimeLog[] }
  | { kind: "flag"; value: boolean }
);

/** A booking of time already made to an issue. */
export interface IssueTimeLog {
  /** What an `IssueTimeRemoval` names it by. */
  id: string;
  author: string;
  /** As the tracker words a duration, "1h 30m". */
  timeSpent: string;
  /** YYYY-MM-DD. */
  spentAt?: string;
  summary?: string;
  /** Whether the viewer's rights take it back. */
  removable: boolean;
}

/** The taking back of a booking, by its `IssueTimeLog.id`. */
export interface IssueTimeRemoval {
  remove: string;
}

/** One booking of time to an issue: how long, when and what was done. */
export interface IssueTimeEntry {
  /** As the tracker takes a duration, "1h 30m". */
  timeSpent: string;
  /** YYYY-MM-DD; left out, it is now. */
  spentAt?: string;
  summary?: string;
}

/** What `setField` sets, by the field's kind: a pick's values; a text, number, date or duration, null
 *  taking it off; a flag's state; a timelog's new entry or the removal of one. */
export type IssueFieldValue = string[] | number | string | boolean | IssueTimeEntry | IssueTimeRemoval | null;

export function isTimeRemoval(value: IssueFieldValue): value is IssueTimeRemoval {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "remove" in value;
}

export interface IssueFieldOptionsResult {
  /** What a pick field can be set to, by the names `IssueField.value` uses. */
  options?: string[];
  error?: string;
}

/** One issue with what its row leaves out, for its tab. */
export interface IssueDetail extends Issue {
  /** Whose Markdown its texts are written in (`issueTextHtml`). */
  provider: ProviderId;
  fields: IssueField[];
  body: string;
  notes: IssueNote[];
  events: IssueEvent[];
  /** The login of the account it was read through. */
  viewer?: string;
  /** What its tracker takes for its text; absent where it takes no file. */
  uploads?: IssueUploads;
  /** Whether a comment can be made internal (`GitProvider.internalNotes`). */
  internalNotes?: boolean;
}

/** What a tracker takes of a file for an issue's text. */
export interface IssueUploads {
  /** File name extensions, without the dot; absent takes any file. */
  extensions?: string[];
}

/** What the issue's tab sets of the issue itself; a part left out stays as it is. Its fields are set
 *  one at a time (`IssueField`). */
export interface IssueChange {
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

export type IssueCreateResult = (ActionDone & { number: number }) | ActionRefused;

export interface IssueUploadResult {
  /** What shows the file in an issue's text. */
  markdown?: string;
  error?: string;
}

export interface IssueReadResult {
  issue?: IssueDetail;
  /** The issue as its tab's text, what an agent reading the tab is answered (`editorContent`). */
  markdown?: string;
  error?: string;
}
