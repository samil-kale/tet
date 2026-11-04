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
  comments: number;
  /** ISO 8601. */
  createdAt: string;
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

export interface IssueListResult {
  issues?: Issue[];
  /** The `issues` of the project's tet.json, where it has one. */
  source?: string;
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
  id: number;
  author: string;
  /** ISO 8601. */
  createdAt: string;
  body: string;
  /** `body` as the host rendered it, where its images are reached only through this. */
  bodyHtml?: string;
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

/** One issue with what its row leaves out, for its tab and a tab it is handed to. */
export interface IssueDetail extends Issue {
  /** All of them; `assignee` is the first. */
  assignees: string[];
  milestone?: string;
  body: string;
  /** As `IssueNote.bodyHtml`. */
  bodyHtml?: string;
  notes: IssueNote[];
  events: IssueEvent[];
  /** The login of the account it was read through. */
  viewer?: string;
  /** What its tracker takes for its text; absent where it takes no file. */
  uploads?: IssueUploads;
}

/** What a tracker takes of a file for an issue's text. */
export interface IssueUploads {
  /** File name extensions, without the dot; absent takes any file. */
  extensions?: string[];
}

export interface IssueMilestone {
  id: number;
  title: string;
}

/** What the issue's tab sets, a list as a whole; a field left out stays as it is. */
export interface IssueChange {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  /** Null takes it off. */
  milestone?: IssueMilestone | null;
  labels?: string[];
  assignees?: string[];
}

export type IssueCreateResult = (ActionDone & { number: number }) | ActionRefused;

export interface IssueUploadResult {
  /** What shows the file in an issue's text. */
  markdown?: string;
  error?: string;
}

export interface IssueReadResult {
  issue?: IssueDetail;
  /** The same as the file a terminal's tab reads. */
  markdown?: string;
  error?: string;
}
