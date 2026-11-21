import { net } from "electron";
import type {
  ChangeRequest,
  ChangeRequestDetail,
  ChangeRequestFilter,
  ChangeRequestKind,
  ChangeRequestRow,
  ChangeRequestsLatest,
  ChecksState,
  Issue,
  IssueChange,
  IssueDetail,
  IssueField,
  IssueFieldValue,
  IssueFilter,
  IssuesLatest,
  IssueUploads,
  RemoteRepository,
} from "../../shared/types/providers";
import { fetchHttpsImage } from "../util/image-response";

/** A repository's issue tracker as one call reaches it: the host, the token of the account it goes
 *  through, and the repository's path there, "owner/name" or "group/subgroup/name". */
export interface Tracker {
  host: string;
  token: string;
  path: string;
}

/** A repository host: authenticate, list repositories with their clone url and read their issues.
 *  One interface for GitHub and GitLab, over plain REST and GraphQL rather than Octokit or GitBeaker,
 *  and kept out of the local git layer: everything past the clone goes through the local git CLI. */
export interface GitProvider {
  /** Checks the token against the host and returns its login. */
  validate(host: string, token: string): Promise<string>;
  /** Every repository the token's user can reach, most recently active first. */
  listRepositories(host: string, token: string): Promise<RemoteRepository[]>;
  /** The first `limit` issues the filter leaves, newest first; every one without a `limit`. */
  listIssues(tracker: Tracker, filter: IssueFilter, limit?: number): Promise<Issue[]>;
  /** How many issues the host counts for the filter and when the latest changed one changed: one
   *  request however long the list. */
  readLatest(tracker: Tracker, filter: IssueFilter): Promise<IssuesLatest>;
  /** Refuses a path the token cannot read, which is how a new issue source is checked. */
  listLabels(tracker: Tracker): Promise<string[]>;
  /** Who can be assigned, so external authors are not among them. */
  listPeople(tracker: Tracker): Promise<string[]>;
  readIssue(tracker: Tracker, number: number): Promise<IssueDetail>;
  /** An image of an issue's text that takes the token to read; undefined for any other source. */
  readImage(tracker: Tracker, source: string): Promise<Response | undefined>;
  /** The file name of an upload a link of an issue's text leads to, one that takes the token to
   *  read; undefined for any other link. */
  uploadName(host: string, source: string): string | undefined;
  /** That upload, read with the token; undefined for any other link. */
  readUpload(tracker: Tracker, source: string): Promise<Response | undefined>;
  /** What a pick field of the issue can be set to, by the names `IssueField.value` uses. */
  listOptions(tracker: Tracker, number: number, fieldId: string): Promise<string[]>;
  /** Sets one field of the issue, a pick's values as a whole; refuses one it does not have or a value
   *  it does not take. */
  setField(tracker: Tracker, number: number, fieldId: string, value: IssueFieldValue): Promise<void>;
  /** Whether a new issue can be made confidential, visible to the project's members alone. */
  readonly confidentialIssues: boolean;
  createIssue(tracker: Tracker, title: string, body: string, confidential: boolean): Promise<number>;
  /** Whether a comment can be made internal, visible to the project's members alone. */
  readonly internalNotes: boolean;
  addComment(tracker: Tracker, number: number, body: string, internal: boolean): Promise<void>;
  /** A comment by its id, which the tracker knows without its issue. */
  editComment(tracker: Tracker, id: string, body: string): Promise<void>;
  deleteComment(tracker: Tracker, id: string): Promise<void>;
  deleteIssue(tracker: Tracker, number: number): Promise<void>;
  /** What `uploadFile` takes on this host; undefined where it takes nothing. */
  uploads(host: string): IssueUploads | undefined;
  /** Uploads a file for an issue's text and answers the Markdown that shows it. */
  uploadFile(tracker: Tracker, name: string, bytes: Buffer<ArrayBuffer>): Promise<string>;
  updateIssue(tracker: Tracker, number: number, change: IssueChange): Promise<void>;
  /** What the host calls a request to merge a branch, and how it writes one's number. */
  readonly changeRequest: ChangeRequestKind;
  /** The open one from `head`, a branch of the repository itself, not of a fork; undefined where
   *  there is none. */
  findChangeRequest(tracker: Tracker, head: string): Promise<ChangeRequest | undefined>;
  /** Opens one from `head` into `base`, both branches of the repository. */
  createChangeRequest(tracker: Tracker, request: ChangeRequestDraft): Promise<ChangeRequest>;
  /** Approves one as the account's user, its author; refused where `changeRequest.selfApproval` is not. */
  approveChangeRequest(tracker: Tracker, number: number): Promise<void>;
  /** Has the host merge one once nothing is outstanding. Never merges at once: with nothing left to
   *  wait for, the host refuses it. */
  autoMergeChangeRequest(tracker: Tracker, number: number, squash: boolean): Promise<void>;
  /** The first `limit` change requests the filter leaves, of the repository's own branches alone,
   *  newest first; every one without a `limit`. */
  listChangeRequests(tracker: Tracker, filter: ChangeRequestFilter, limit?: number): Promise<ChangeRequestRow[]>;
  /** What the host says of the filtered list without sending it whole (`ChangeRequestsLatest`): one
   *  request. */
  readChangeRequestsLatest(tracker: Tracker, filter: ChangeRequestFilter): Promise<ChangeRequestsLatest>;
  readChangeRequest(tracker: Tracker, number: number): Promise<ChangeRequestDetail>;
  /** `listOptions` and `setField` of a change request. */
  listChangeRequestOptions(tracker: Tracker, number: number, fieldId: string): Promise<string[]>;
  setChangeRequestField(tracker: Tracker, number: number, fieldId: string, value: IssueFieldValue): Promise<void>;
  /** Its title, text or state; merged it is set by `mergeChangeRequest` alone. */
  updateChangeRequest(tracker: Tracker, number: number, change: IssueChange): Promise<void>;
  commentChangeRequest(tracker: Tracker, number: number, body: string): Promise<void>;
  /** Merges one by the repository's own method, at once, or with `whenChecksPass` once its checks
   *  passed, as `autoMergeChangeRequest` has the host do. */
  mergeChangeRequest(tracker: Tracker, number: number, whenChecksPass: boolean): Promise<void>;
  /** The variables the host's own CLI and scripts read the account's token from, which a host tab of
   *  a project on this host gets: the rest of the API, which this interface leaves out, is the
   *  agent's to call. */
  tokenEnv(host: string, token: string): Record<string, string>;
}

/** What `createChangeRequest` opens. */
export interface ChangeRequestDraft {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  /** Ignored where `changeRequest.deletesSourceBranch` is not. */
  deleteSourceBranch: boolean;
}

/** Pages follow the RFC 5988 `Link` header both hosts send; the cap bounds an account reaching
 *  thousands of repositories. */
const PAGE_CAP = 10;

/** A host's non-2xx answer: `status` to go by, the message to tell. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One GET; a non-2xx status throws with what the API said. `net.fetch`, never the global fetch: only
 * Chromium's stack applies the machine's proxy settings and certificate store, so a company proxy or
 * private root certificate works. `no-store`: its HTTP cache would answer a host's reads for their
 * `max-age`, and a write invalidates only its own URL, so what was just written would not read back.
 * `redirect: "error"`: the stack sends a request's headers, the token's, on to wherever a redirect leads.
 */
export async function fetchOk(url: string, headers: Record<string, string>, init?: { method: string; body?: BodyInit }): Promise<Response> {
  const response = await net.fetch(url, { headers, cache: "no-store", redirect: "error", ...init });
  if (!response.ok) {
    throw new ApiError(response.status, await apiError(response));
  }
  return response;
}

/** An image read with a token, which stays with its first hop: a redirect leads to storage. What the
 *  host refused throws — see fetchOk — so that the next account gets to try. */
export async function fetchImageOk(url: string, headers: Record<string, string>, timeoutMs?: number): Promise<Response | undefined> {
  const response = await fetchHttpsImage(url, undefined, headers, timeoutMs);
  if (response && !response.ok) {
    void response.body?.cancel();
    throw new ApiError(response.status, `${response.status} ${response.statusText}`.trim());
  }
  return response;
}

/** An upload may take as long as the update's download: it is a file of up to either tracker's cap. */
const READ_UPLOAD_TIMEOUT_MS = 15 * 60_000;

/** An upload of an issue's text read with a token, as `fetchImageOk` reads an image. */
export function fetchUploadOk(url: string, headers: Record<string, string>): Promise<Response | undefined> {
  return fetchImageOk(url, headers, READ_UPLOAD_TIMEOUT_MS);
}

/** One DELETE, whose answer is not read — see fetchOk. */
export async function sendDelete(url: string, headers: Record<string, string>): Promise<void> {
  const response = await fetchOk(url, headers, { method: "DELETE" });
  void response.body?.cancel();
}

/** What a GraphQL answer refused, which it says under a status of 200. */
export function graphqlError(body: { errors?: { message?: string }[] }): string | undefined {
  const messages = body.errors?.map((error) => error.message ?? "").filter((message) => message !== "");
  return body.errors === undefined || body.errors.length === 0 ? undefined : messages?.join("; ") || "The host refused the request";
}

/** One GraphQL request, answering its `data`; what it refused throws — see fetchOk. */
export async function sendGraphql(url: string, headers: Record<string, string>, query: string, variables: object): Promise<unknown> {
  const response = await fetchOk(
    url,
    { ...headers, "Content-Type": "application/json" },
    { method: "POST", body: JSON.stringify({ query, variables }) },
  );
  const body = (await response.json()) as { data?: unknown; errors?: { message?: string }[] };
  const refused = graphqlError(body);
  if (refused !== undefined) {
    throw new Error(refused);
  }
  return body.data;
}

/** Sends one GraphQL request to a host, answering its `data` (`sendGraphql`). */
export type GraphqlSend = (query: string, variables: object) => Promise<unknown>;

/** A page of a GraphQL listing, with where the next starts. */
export interface GraphqlPage<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

/** Every page of a GraphQL listing up to the cap, from `variables`' `cursor` where it has one; `pageOf`
 *  finds it in an answer. */
export async function allNodes<T>(
  send: GraphqlSend,
  query: string,
  variables: Record<string, unknown>,
  pageOf: (data: unknown) => GraphqlPage<T>,
): Promise<T[]> {
  const nodes: T[] = [];
  let cursor = (variables.cursor ?? null) as string | null;
  for (let page = 0; page < PAGE_CAP; page++) {
    const answer = pageOf(await send(query, { ...variables, cursor }));
    nodes.push(...answer.nodes);
    if (!answer.pageInfo.hasNextPage) {
      break;
    }
    cursor = answer.pageInfo.endCursor;
  }
  return nodes;
}

/** The most nodes either host sends in one page of a GraphQL listing. */
const GRAPHQL_PAGE = 100;

/**
 * The first `limit` nodes of a GraphQL listing that `keep` keeps, every one up to the cap without a
 * `limit`: `allNodes` for a query that takes its page's size as `$first`. Each page asks for `limit` at
 * most, so a short list costs no more than it shows, and for as many again where `keep` dropped some.
 */
export async function firstNodes<T>(
  send: GraphqlSend,
  query: string,
  variables: Record<string, unknown>,
  pageOf: (data: unknown) => GraphqlPage<T>,
  limit?: number,
  keep: (node: T) => boolean = () => true,
): Promise<T[]> {
  const first = Math.min(limit ?? GRAPHQL_PAGE, GRAPHQL_PAGE);
  const nodes: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGE_CAP; page++) {
    const answer = pageOf(await send(query, { ...variables, first, cursor }));
    nodes.push(...answer.nodes.filter(keep));
    if (!answer.pageInfo.hasNextPage || (limit !== undefined && nodes.length >= limit)) {
      break;
    }
    cursor = answer.pageInfo.endCursor;
  }
  return nodes.slice(0, limit);
}

/** What a pick field lists: a name as `IssueField.value` shows it, with the id the tracker addresses it by. */
export interface NamedId {
  id: string;
  name: string;
}

/** The ids of what a host names, by those names; GraphQL sets labels and people by id alone. Refuses a
 *  name it does not know, so nothing is dropped unseen. */
export function idsByName(names: string[], known: NamedId[], what: string): string[] {
  return names.map((name) => {
    const entry = known.find((candidate) => candidate.name === name);
    if (!entry) {
      throw new Error(`${name} is no ${what} of this project`);
    }
    return entry.id;
  });
}

/** A field the tab picks from a list. */
export function pickField(
  id: string,
  name: string,
  value: string[],
  {
    several = false,
    shown = "text",
    editable = true,
  }: { several?: boolean; shown?: "text" | "people" | "labels" | "issues"; editable?: boolean } = {},
): IssueField {
  return { id, name, editable, kind: "pick", value, several, shown };
}

/** The text a field is set to, null taking it off; refuses a value of another kind. */
export function textOf(value: IssueFieldValue): string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error("It takes text");
  }
  return value;
}

/** The number a field is set to, null taking it off; refuses a value of another kind. */
export function numberOf(value: IssueFieldValue, whole = false): number | null {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || (whole && !Number.isInteger(value)))) {
    throw new Error(whole ? "It takes a whole number" : "It takes a number");
  }
  return value;
}

/** A mutation in a host's words: its name, the type of its input, and the input. */
export interface Write {
  mutation: string;
  inputType: string;
  input: object;
}

/**
 * One mutation, answering what it was asked to select. A refusal comes as a GraphQL error
 * (`sendGraphql`) or, where the host words it in a field of the payload, in the `errors` the caller
 * selects.
 */
export async function sendMutation<T>(send: GraphqlSend, { mutation, inputType, input }: Write, selection: string): Promise<T> {
  const query = `mutation($input: ${inputType}!) { ${mutation}(input: $input) { ${selection} } }`;
  const data = (await send(query, { input })) as Record<string, (T & { errors?: string[] }) | null> | null;
  const result = data?.[mutation];
  if (!result) {
    throw new Error("The host answered the change with nothing");
  }
  if (result.errors && result.errors.length > 0) {
    throw new Error(result.errors.join("; "));
  }
  return result;
}

/** What a field's choices and its change are made with: the issue, and the target a change is made
 *  on, which is read when first asked for and once. */
export interface FieldContext<Target> {
  send: GraphqlSend;
  path: string;
  number: number;
  target: () => Promise<Target>;
}

export function fieldContext<Target>(send: GraphqlSend, path: string, number: number, read: () => Promise<Target>): FieldContext<Target> {
  let target: Promise<Target> | undefined;
  return {
    send,
    path,
    number,
    target: () => {
      target ??= read();
      return target;
    },
  };
}

/** A field of a tracker: where its choices are listed, for a pick, and the mutation that sets it. */
export interface FieldHandler<Target> {
  pick?: {
    /** What one value is, for the refusal of an unknown name. */
    what: string;
    choices: (context: FieldContext<Target>) => Promise<NamedId[]>;
  };
  /** `ids` are those of the values of a pick, which `writeOf` looks up. */
  write: (target: Target, value: IssueFieldValue, ids: string[]) => Write;
}

/** A pick, set by the ids of the values chosen. */
export function pickHandler<Target>(
  pick: NonNullable<FieldHandler<Target>["pick"]>,
  write: (target: Target, ids: string[]) => Write,
): FieldHandler<Target> {
  return { pick, write: (target, _value, ids) => write(target, ids) };
}

/** A field set by its value. */
export function valueHandler<Target>(write: (target: Target, value: IssueFieldValue) => Write): FieldHandler<Target> {
  return { write };
}

/** What a pick field can be set to, by the names `IssueField.value` uses. */
export async function optionsOf<Target>(handler: FieldHandler<Target>, context: FieldContext<Target>, fieldId: string): Promise<string[]> {
  if (!handler.pick) {
    throw new Error(`${fieldId} is no field to choose from`);
  }
  return (await handler.pick.choices(context)).map((entry) => entry.name);
}

/** The mutation that sets a field to `value`; a pick's names are looked up in its choices. */
export async function writeOf<Target>(
  handler: FieldHandler<Target>,
  context: FieldContext<Target>,
  fieldId: string,
  value: IssueFieldValue,
): Promise<Write> {
  if (!handler.pick) {
    return handler.write(await context.target(), value, []);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldId} takes a list of values`);
  }
  const [choices, target] = await Promise.all([handler.pick.choices(context), context.target()]);
  return handler.write(target, value, idsByName(value, choices, handler.pick.what));
}

/** `listOptions` and `setField` of a tracker, by its fields' handlers: the same steps for every one. */
export function fieldMethods<Target>(tracker: {
  graphql: (host: string, token: string) => GraphqlSend;
  /** The field an id names; a tracker whose fields depend on the repository looks it up in it. */
  handlerOf: (send: GraphqlSend, path: string, fieldId: string) => FieldHandler<Target> | Promise<FieldHandler<Target>>;
  /** What a change of a field needs of the issue. */
  readTarget: (send: GraphqlSend, path: string, number: number) => Promise<Target>;
  mutate: (send: GraphqlSend, write: Write) => Promise<unknown>;
}): Pick<GitProvider, "listOptions" | "setField"> {
  const contextOf = (send: GraphqlSend, path: string, number: number): FieldContext<Target> =>
    fieldContext(send, path, number, () => tracker.readTarget(send, path, number));
  return {
    async listOptions({ host, token, path }, number, fieldId) {
      const send = tracker.graphql(host, token);
      return optionsOf(await tracker.handlerOf(send, path, fieldId), contextOf(send, path, number), fieldId);
    },
    async setField({ host, token, path }, number, fieldId, value) {
      const send = tracker.graphql(host, token);
      await tracker.mutate(
        send,
        await writeOf(await tracker.handlerOf(send, path, fieldId), contextOf(send, path, number), fieldId, value),
      );
    },
  };
}

/** `ChangeRequestsLatest.checks` of a list: each one's number and checks, by number. */
export function checksText(rows: { number: number; checks?: ChecksState }[]): string {
  return rows
    .map((row) => `${row.number}:${row.checks ?? ""}`)
    .sort()
    .join(",");
}

/** One GET as JSON — see fetchOk. */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  return (await fetchOk(url, headers)).json();
}

/**
 * Every page of a listing, up to the cap. With `rel="last"` the rest are fetched in parallel, as
 * following `rel="next"` one by one adds up each page's wait. Else `rel="next"`.
 */
export async function getPaged(first: string, headers: Record<string, string>): Promise<unknown[]> {
  const response = await fetchOk(first, headers);
  const items = arrayBody(await response.json());
  const link = response.headers.get("link");
  const last = relLink(link, "last");
  const lastPage = last === undefined ? undefined : pageOf(last);
  if (last === undefined || lastPage === undefined) {
    let url = relLink(link, "next");
    for (let page = 1; url !== undefined && page < PAGE_CAP; page++) {
      const rest = await fetchOk(url, headers);
      items.push(...arrayBody(await rest.json()));
      url = relLink(rest.headers.get("link"), "next");
    }
    return items;
  }
  const urls: string[] = [];
  for (let page = 2; page <= Math.min(lastPage, PAGE_CAP); page++) {
    urls.push(withPage(last, page));
  }
  const bodies = await Promise.all(urls.map(async (url) => arrayBody(await getJson(url, headers))));
  for (const body of bodies) {
    items.push(...body);
  }
  return items;
}

/** A body that is not an array counts as empty. */
function arrayBody(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [];
}

function relLink(header: string | null, rel: string): string | undefined {
  const match = new RegExp(`<([^>]+)>;\\s*rel="${rel}"`).exec(header ?? "");
  return match?.[1];
}

/** The url's `page` parameter, which both hosts page by. */
function pageOf(url: string): number | undefined {
  const value = Number(new URL(url).searchParams.get("page"));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function withPage(url: string, page: number): string {
  const next = new URL(url);
  next.searchParams.set("page", String(page));
  return next.toString();
}

/** Both APIs put their reason in a `message` field; the status line is the fallback. */
async function apiError(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") {
      return `${body.message} (${status})`;
    }
  } catch {
    // Not JSON, e.g. a proxy's error page.
  }
  return status;
}
