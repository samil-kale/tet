import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AccountStore } from "../../src/main/providers/accounts";
import { PROVIDERS } from "../../src/main/providers";
import {
  contentTypeOf,
  github,
  carriesAll,
  issuesVariables as gitHubIssuesVariables,
  readsWithToken,
  toEvents as toGitHubEvents,
  FIELD_HANDLERS as GITHUB_FIELD_HANDLERS,
  issueFieldOf as gitHubIssueFieldOf,
  parentName as gitHubParentName,
  toFields as toGitHubFields,
  toIssue as toGitHubIssue,
  toIssueInput as toGitHubInput,
  uploadMarkdown,
} from "../../src/main/providers/github";
import {
  durationText,
  FIELD_HANDLERS as GITLAB_FIELD_HANDLERS,
  gitlab,
  issuesVariables,
  iterationName,
  parentName,
  toEvents as toGitLabEvents,
  toFields as toGitLabFields,
  toIssue as toGitLabIssue,
  toIssueInput,
  toNotes as toGitLabNotes,
  toTimeLogs,
  uploadOf,
} from "../../src/main/providers/gitlab";
import {
  issueMarkdown,
  NoAccountError,
  onTracker,
  parseRemoteUrl,
  setIssueSource,
  writeOnTracker,
  type IssueAccounts,
  type IssueRepository,
} from "../../src/main/providers/issues";
import {
  ApiError,
  fieldContext,
  graphqlError,
  idsByName,
  optionsOf,
  pickHandler,
  sendMutation,
  valueHandler,
  writeOf,
  type Tracker,
} from "../../src/main/providers/provider";
import { RepoCache } from "../../src/main/providers/repo-cache";
import { readIssueSource } from "../../src/main/store/tet-json";
import type { IssueFieldValue, ProviderAccount } from "../../src/shared/types/providers";
import { fakeSafeStorage, tempDir } from "../helpers";

/** providers/: the accounts kept for the providers, and the issues read through them. */

describe("the issues of a tracker", () => {
  const githubIssue = {
    number: 412,
    title: "Focus is lost",
    url: "https://github.com/o/r/issues/412",
    state: "OPEN",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-04T10:00:00Z",
    author: { login: "mira", avatarUrl: "https://avatars.example.com/u/1?v=4" },
    assignees: {
      nodes: [
        { login: "jonas", avatarUrl: "https://avatars.example.com/u/2?v=4" },
        null,
        { login: "lena", avatarUrl: "https://avatars.example.com/u/3" },
      ],
    },
    labels: { nodes: [{ name: "bug" }, { name: "terminals" }] },
    body: "Text",
  };
  const gitlabIssue = {
    iid: "12",
    title: "VAT",
    webUrl: "https://gitlab.example.com/g/t/-/issues/12",
    state: "closed",
    createdAt: "2026-10-02T10:00:00Z",
    updatedAt: "2026-10-05T10:00:00Z",
    author: { username: "anna" },
    assignees: { nodes: [] },
    labels: { nodes: [{ title: "type::bug" }] },
    description: null,
  };

  it("reads GitHub's and GitLab's issues as one row, a deleted account as ghost", () => {
    assert.deepEqual(toGitHubIssue(githubIssue), {
      number: 412,
      title: "Focus is lost",
      url: "https://github.com/o/r/issues/412",
      open: true,
      author: "mira",
      assignee: "jonas",
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-04T10:00:00Z",
      labels: ["bug", "terminals"],
      avatars: {
        mira: "https://avatars.example.com/u/1?v=4&s=40",
        jonas: "https://avatars.example.com/u/2?v=4&s=40",
        lena: "https://avatars.example.com/u/3?s=40",
      },
    });
    assert.deepEqual(toGitLabIssue(gitlabIssue), {
      number: 12,
      title: "VAT",
      url: "https://gitlab.example.com/g/t/-/issues/12",
      open: false,
      author: "anna",
      assignee: undefined,
      createdAt: "2026-10-02T10:00:00Z",
      updatedAt: "2026-10-05T10:00:00Z",
      labels: ["type::bug"],
      avatars: {},
    });
    assert.equal(toGitHubIssue({ ...githubIssue, author: null }).author, "ghost");
    assert.equal(toGitHubIssue({ ...githubIssue, author: null }).avatars.ghost, undefined);
  });

  it("reads what happened to an issue off GitHub's timeline, leaving out what the tab does not draw", () => {
    const happened = { createdAt: "a", actor: { login: "mira", avatarUrl: "https://a/1" } };
    const base = { actor: "mira", createdAt: "a" };
    assert.deepEqual(
      toGitHubEvents([
        { __typename: "SubscribedEvent", ...happened },
        { __typename: "ClosedEvent", ...happened },
        { __typename: "ReopenedEvent", createdAt: "a", actor: null },
        { __typename: "AssignedEvent", ...happened, assignee: { login: "jonas" } },
        { __typename: "UnassignedEvent", ...happened, assignee: {} },
        { __typename: "UnassignedEvent", ...happened, assignee: { login: "jonas" } },
        { __typename: "LabeledEvent", ...happened, label: { name: "bug" } },
        { __typename: "UnlabeledEvent", ...happened, label: { name: "bug" } },
        { __typename: "MilestonedEvent", ...happened, milestoneTitle: "May" },
        { __typename: "DemilestonedEvent", ...happened, milestoneTitle: "May" },
        { __typename: "RenamedTitleEvent", ...happened, previousTitle: "A", currentTitle: "B" },
        { __typename: "CrossReferencedEvent", ...happened, source: { number: 7, title: "T", url: "https://x/7" } },
        { __typename: "CrossReferencedEvent", ...happened, source: {} },
      ]),
      [
        { ...base, kind: "closed" },
        { actor: "ghost", createdAt: "a", kind: "reopened" },
        { ...base, kind: "assigned", login: "jonas" },
        { ...base, kind: "unassigned", login: "jonas" },
        { ...base, kind: "labeled", label: "bug" },
        { ...base, kind: "unlabeled", label: "bug" },
        { ...base, kind: "milestoned", milestone: "May" },
        { ...base, kind: "demilestoned", milestone: "May" },
        { ...base, kind: "renamed", from: "A", to: "B" },
        { ...base, kind: "linked", number: 7, title: "T", url: "https://x/7" },
      ],
    );
  });

  it("reads what happened to an issue off GitLab's records and system notes", () => {
    const user = { username: "anna" };
    const created_at = "2026-10-01T10:00:00Z";
    const base = { actor: "anna", createdAt: created_at };
    assert.deepEqual(
      toGitLabEvents(
        [
          { id: "n1", system: true, internal: false, author: user, createdAt: created_at, body: "assigned to @anna" },
          { id: "n2", system: false, internal: false, author: user, createdAt: created_at, body: "Comment" },
        ],
        [
          { user, created_at, action: "add", label: { name: "bug" } },
          { user, created_at, action: "remove", label: { name: "bug" } },
          { user, created_at, action: "add", label: null },
        ],
        [
          { user, created_at, state: "closed" },
          { user: null, created_at, state: "reopened" },
        ],
        [
          { user, created_at, action: "add", milestone: { title: "May" } },
          { user, created_at, action: "remove", milestone: { title: "May" } },
          { user, created_at, action: "remove", milestone: null },
        ],
      ),
      [
        { ...base, kind: "text", text: "assigned to @anna" },
        { ...base, kind: "labeled", label: "bug" },
        { ...base, kind: "unlabeled", label: "bug" },
        { ...base, kind: "closed" },
        { actor: "ghost", createdAt: created_at, kind: "reopened" },
        { ...base, kind: "milestoned", milestone: "May" },
        { ...base, kind: "demilestoned", milestone: "May" },
      ],
    );
  });

  it("asks each host for the filter in its own words", () => {
    const filter = { state: "closed" as const, author: "mira", assignee: "jonas", labels: ["bug", "ui"] };
    // As it is sent: what is left out stays out of the request.
    const hub = (...args: Parameters<typeof gitHubIssuesVariables>): unknown => JSON.parse(JSON.stringify(gitHubIssuesVariables(...args)));
    assert.deepEqual(hub("o/r", filter), {
      owner: "o",
      name: "r",
      filter: { states: ["CLOSED"], createdBy: "mira", assignee: "jonas", labels: ["bug", "ui"] },
    });
    assert.deepEqual(hub("o/r", { state: "open", labels: [] }), { owner: "o", name: "r", filter: { states: ["OPEN"] } });
    assert.deepEqual(hub("o/r", { labels: [] }), { owner: "o", name: "r", filter: {} });

    const sent = (...args: Parameters<typeof issuesVariables>): unknown => JSON.parse(JSON.stringify(issuesVariables(...args)));
    assert.deepEqual(sent("g/s/t", filter), {
      path: "g/s/t",
      state: "closed",
      authorUsername: "mira",
      assigneeUsernames: ["jonas"],
      labelName: ["bug", "ui"],
    });
    assert.deepEqual(sent("g/t", { state: "open", labels: [] }), { path: "g/t", state: "opened" });
    assert.deepEqual(sent("g/t", { labels: [] }), { path: "g/t" });
  });

  it("finds an upload to read with the token, on the account's host alone", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const host = "gitlab.example.com";
    const upload = { secret, file: "a%20b.png" };
    assert.deepEqual(uploadOf(host, `/uploads/${secret}/a%20b.png`), upload);
    assert.deepEqual(uploadOf(host, `uploads/${secret}/a%20b.png`), upload);
    assert.deepEqual(uploadOf(host, `https://${host}/g/p/uploads/${secret}/a%20b.png`), upload);
    assert.equal(uploadOf(host, `https://elsewhere.example.com/uploads/${secret}/a.png`), undefined);
    assert.equal(uploadOf(host, `http://${host}/uploads/${secret}/a.png`), undefined);
    assert.equal(uploadOf(host, "/uploads/nothex/a.png"), undefined);
    assert.equal(uploadOf(host, `/uploads/${secret}/../../user`), undefined);
    assert.equal(uploadOf(host, "docs/a.png"), undefined);
  });

  it("asks for an image with GitHub's token on the account's host alone", () => {
    assert.equal(readsWithToken("github.com", "https://github.com/user-attachments/assets/1"), true);
    assert.equal(readsWithToken("github.com", "https://GitHub.com/a.png"), true);
    assert.equal(readsWithToken("github.com", "https://example.com/a.png"), false);
    assert.equal(readsWithToken("github.com", "https://github.com.example.com/a.png"), false);
    assert.equal(readsWithToken("github.com", "http://github.com/a.png"), false);
    assert.equal(readsWithToken("github.com", "docs/a.png"), false);
  });

  it("puts a change in GitLab's words", () => {
    const issue = { projectPath: "g/t", iid: "12" };
    // As it is sent: what is left out stays out of the request.
    const sent = (change: Parameters<typeof toIssueInput>[2]): unknown => JSON.parse(JSON.stringify(toIssueInput("g/t", 12, change)));
    assert.deepEqual(sent({ title: "T", body: "B" }), { ...issue, title: "T", description: "B" });
    assert.deepEqual(sent({ state: "closed" }), { ...issue, stateEvent: "CLOSE" });
    assert.deepEqual(sent({ state: "open" }), { ...issue, stateEvent: "REOPEN" });
  });

  it("puts the change of a field in GitLab's words, a pick by the ids of its values", () => {
    const target = {
      id: "W1",
      labels: [
        { id: "L1", name: "bug" },
        { id: "L2", name: "ui" },
      ],
    };
    const write = (fieldId: string, value: IssueFieldValue, ids: string[] = []) => GITLAB_FIELD_HANDLERS[fieldId].write(target, value, ids);
    // What `workItemUpdate` is sent, as it is sent: a null stays in, what is left out stays out.
    const sent = (fieldId: string, value: IssueFieldValue, ids: string[] = []): unknown => {
      const { mutation, inputType, input } = JSON.parse(JSON.stringify(write(fieldId, value, ids))) as {
        mutation: string;
        inputType: string;
        input: { id: string };
      };
      assert.deepEqual([mutation, inputType, input.id], ["workItemUpdate", "WorkItemUpdateInput", "W1"]);
      const { id, ...widgets } = input;
      assert.equal(id, "W1");
      return widgets;
    };
    assert.deepEqual(sent("assignees", ["a"], ["U1"]), { assigneesWidget: { assigneeIds: ["U1"] } });
    assert.deepEqual(sent("labels", ["ui", "new"], ["L2", "L3"]), { labelsWidget: { addLabelIds: ["L3"], removeLabelIds: ["L1"] } });
    assert.deepEqual(sent("milestone", [], []), { milestoneWidget: { milestoneId: null } });
    assert.deepEqual(sent("iteration", ["i"], ["I1"]), { iterationWidget: { iterationId: "I1" } });
    assert.deepEqual(sent("parent", ["p"], ["P1"]), { hierarchyWidget: { parentId: "P1" } });
    assert.deepEqual(sent("health", [], []), { healthStatusWidget: { healthStatus: null } });
    assert.deepEqual(sent("status", ["Done"], ["S3"]), { statusWidget: { status: "S3" } });
    assert.throws(() => sent("status", [], []), /status cannot be taken off/);
    assert.deepEqual(sent("weight", 3), { weightWidget: { weight: 3 } });
    assert.deepEqual(sent("weight", null), { weightWidget: { weight: null } });
    assert.throws(() => sent("weight", 1.5), /whole number/);
    assert.deepEqual(sent("startDate", "2026-11-01"), { startAndDueDateWidget: { startDate: "2026-11-01" } });
    assert.deepEqual(sent("dueDate", null), { startAndDueDateWidget: { dueDate: null } });
    assert.deepEqual(sent("timeEstimate", "3h"), { timeTrackingWidget: { timeEstimate: "3h" } });
    assert.deepEqual(sent("timeEstimate", null), { timeTrackingWidget: { timeEstimate: "0" } });
    assert.deepEqual(sent("timeSpent", { timeSpent: "1h 30m" }), { timeTrackingWidget: { timelog: { timeSpent: "1h 30m" } } });
    assert.deepEqual(sent("timeSpent", { timeSpent: "1h", spentAt: "2026-11-08", summary: "Fixed it" }), {
      timeTrackingWidget: { timelog: { timeSpent: "1h", spentAt: "2026-11-08", summary: "Fixed it" } },
    });
    assert.deepEqual(sent("timeSpent", { timeSpent: "1h", spentAt: "", summary: "" }), {
      timeTrackingWidget: { timelog: { timeSpent: "1h" } },
    });
    assert.throws(() => sent("timeSpent", "1h"), /added as an entry/);
    assert.throws(() => sent("timeSpent", null), /added as an entry/);
    assert.deepEqual(write("timeSpent", { remove: "T1" }), {
      mutation: "timelogDelete",
      inputType: "TimelogDeleteInput",
      input: { id: "T1" },
    });
    assert.deepEqual(sent("confidential", true), { confidential: true });
    assert.throws(() => sent("confidential", "yes"), /on or off/);
    assert.equal(GITLAB_FIELD_HANDLERS.nothing, undefined, "a field GitLab does not have");
  });

  it("lists the fields a GitLab work item has, each only where its widget is", () => {
    const iteration = { id: "I1", title: null, startDate: "2026-11-11", dueDate: "2026-12-08", iterationCadence: { title: "Scrum" } };
    assert.equal(iterationName(iteration), "Scrum: 2026-11-11 – 2026-12-08");
    assert.equal(iterationName({ ...iteration, title: "Sprint 4" }), "Scrum: Sprint 4");
    const parent = { iid: "42", title: "Epic one", workItemType: { name: "Epic" }, namespace: { fullPath: "g/m" } };
    assert.equal(parentName(parent), "Epic one (g/m&42)");
    assert.equal(parentName({ ...parent, workItemType: { name: "Issue" } }), "Epic one (g/m#42)");
    const user = (username: string) => ({ username });
    assert.deepEqual(
      toGitLabFields({
        confidential: true,
        widgets: [
          { type: "PARTICIPANTS", participants: { nodes: [user("anna")] } },
          { type: "LABELS", labels: { nodes: [{ title: "bug" }] } },
          { type: "ASSIGNEES", assignees: { nodes: [user("jonas"), user("lena")] } },
          { type: "WEIGHT", weight: 3 },
          { type: "MILESTONE", milestone: null },
          { type: "ITERATION", iteration },
          { type: "HIERARCHY", parent },
          { type: "START_AND_DUE_DATE", startDate: "2026-11-01", dueDate: null },
          { type: "HEALTH_STATUS", healthStatus: "atRisk" },
          { type: "TIME_TRACKING", humanReadableAttributes: { timeEstimate: "3h", totalTimeSpent: null } },
          { type: "STATUS", status: { name: "In progress" } },
          { type: "DESCRIPTION" },
        ],
      }).map(({ id, name, editable, ...rest }) => [id, name, editable, rest]),
      [
        ["status", "Status", true, { kind: "pick", value: ["In progress"], several: false, shown: "labels" }],
        ["assignees", "Assignees", true, { kind: "pick", value: ["jonas", "lena"], several: true, shown: "people" }],
        ["labels", "Labels", true, { kind: "pick", value: ["bug"], several: true, shown: "labels" }],
        ["parent", "Parent", true, { kind: "pick", value: ["Epic one (g/m&42)"], several: false, shown: "text" }],
        ["weight", "Weight", true, { kind: "number", value: 3 }],
        ["milestone", "Milestone", true, { kind: "pick", value: [], several: false, shown: "text" }],
        ["iteration", "Iteration", true, { kind: "pick", value: ["Scrum: 2026-11-11 – 2026-12-08"], several: false, shown: "text" }],
        ["startDate", "Start date", true, { kind: "date", group: "Dates", value: "2026-11-01" }],
        ["dueDate", "Due date", true, { kind: "date", group: "Dates", value: undefined }],
        ["health", "Health status", true, { kind: "pick", value: ["At risk"], several: false, shown: "text" }],
        ["timeEstimate", "Estimate", true, { kind: "duration", group: "Time tracking", value: "3h" }],
        ["timeSpent", "Time spent", true, { kind: "timelog", group: "Time tracking", value: undefined, entries: [] }],
        ["confidential", "Confidential", true, { kind: "flag", value: true }],
        ["participants", "Participants", false, { kind: "pick", value: ["anna"], several: true, shown: "people" }],
      ],
    );
    assert.deepEqual(
      toGitLabFields({ confidential: false, widgets: [{ type: "LABELS", labels: { nodes: [] } }] }).map((field) => field.id),
      ["labels", "confidential"],
      "a type without the widgets has no such fields",
    );
    assert.deepEqual(
      toGitLabFields({ confidential: false, widgets: [{ type: "WEIGHT" }, { type: "WEIGHT", weight: null }] }).map((field) => field.id),
      ["weight", "confidential"],
      "a widget answered without its data is skipped for the one with it",
    );
    assert.deepEqual(
      toGitLabFields({ confidential: false, widgets: [{ type: "WEIGHT" }, { type: "HEALTH_STATUS" }] }).map((field) => field.id),
      ["confidential"],
      "a widget whose data was not read has no field",
    );
  });

  it("words a duration in seconds as GitLab does, by its calendar of 8 hours a day", () => {
    assert.equal(durationText(5400), "1h 30m");
    assert.equal(durationText(8 * 3600), "1d");
    assert.equal(durationText(5 * 8 * 3600 + 3 * 8 * 3600 + 3600 + 60), "1w 3d 1h 1m");
    assert.equal(durationText(4 * 5 * 8 * 3600 + 60), "1mo 1m");
    assert.equal(durationText(-1800), "-30m");
    assert.equal(durationText(0), "0m");
  });

  it("lists the bookings of time of a work item, newest first", () => {
    const log = (id: string, timeSpent: number, spentAt: string | null, summary: string | null, adminTimelog: boolean) => ({
      id,
      timeSpent,
      spentAt,
      summary,
      user: { username: "anna" },
      userPermissions: { adminTimelog },
    });
    assert.deepEqual(
      toTimeLogs([
        log("T1", 3600, "2026-10-30T00:00:00Z", "Fixed it", true),
        log("T2", 5400, "2026-11-02T08:15:00Z", "", false),
        log("T3", 60, null, null, true),
      ]),
      [
        { id: "T2", author: "anna", timeSpent: "1h 30m", spentAt: "2026-11-02", summary: undefined, removable: false },
        { id: "T1", author: "anna", timeSpent: "1h", spentAt: "2026-10-30", summary: "Fixed it", removable: true },
        { id: "T3", author: "anna", timeSpent: "1m", spentAt: undefined, summary: undefined, removable: true },
      ],
    );
  });

  it("has a handler for each field a GitLab work item lists as changeable, and for no other", () => {
    const listed = toGitLabFields({
      confidential: false,
      widgets: [
        { type: "STATUS", status: null },
        { type: "ASSIGNEES", assignees: { nodes: [] } },
        { type: "LABELS", labels: { nodes: [] } },
        { type: "HIERARCHY", parent: null },
        { type: "WEIGHT", weight: null },
        { type: "MILESTONE", milestone: null },
        { type: "ITERATION", iteration: null },
        { type: "START_AND_DUE_DATE", startDate: null, dueDate: null },
        { type: "HEALTH_STATUS", healthStatus: null },
        { type: "TIME_TRACKING", humanReadableAttributes: { timeEstimate: null, totalTimeSpent: null } },
        { type: "PARTICIPANTS", participants: { nodes: [] } },
      ],
    });
    assert.equal(listed.length, 14);
    for (const field of listed) {
      const handler = Object.hasOwn(GITLAB_FIELD_HANDLERS, field.id) ? GITLAB_FIELD_HANDLERS[field.id] : undefined;
      assert.equal(handler !== undefined, field.editable, field.id);
      if (handler) {
        assert.equal(handler.pick !== undefined, field.kind === "pick", `${field.id} is picked from a list`);
      }
    }
  });

  it("finds ids by their names, refusing a name it does not know", () => {
    const labels = [
      { id: "gid://gitlab/ProjectLabel/1", name: "bug" },
      { id: "gid://gitlab/GroupLabel/2", name: "ui" },
    ];
    assert.deepEqual(idsByName(["ui", "bug"], labels, "label"), ["gid://gitlab/GroupLabel/2", "gid://gitlab/ProjectLabel/1"]);
    assert.deepEqual(idsByName([], labels, "label"), []);
    assert.throws(() => idsByName(["new"], labels, "label"), /new is no label/);
  });

  it("reads a title change off GitLab's system note, rendered or in Markdown", () => {
    const author = { username: "anna" };
    const created_at = "2026-10-01T10:00:00Z";
    const titleOf = (body: string) =>
      toGitLabEvents([{ id: "n", system: true, internal: false, author, createdAt: created_at, body }], [], [], [])[0];
    const base = { actor: "anna", createdAt: created_at };
    assert.deepEqual(
      titleOf(
        '<p>changed title from <code class="idiff">Edit a member&#39;s &quot;role&quot; &amp;amp;</code> to <code class="idiff"><span class="idiff left right addition">IXUS: </span>Edit a member&#39;s &quot;role&quot; &amp;amp;</code></p>',
      ),
      { ...base, kind: "renamed", from: 'Edit a member\'s "role" &amp;', to: 'IXUS: Edit a member\'s "role" &amp;' },
    );
    assert.deepEqual(titleOf("changed title from **Provide{-r more-} info** to **Provide{+ more user+} info**"), {
      ...base,
      kind: "renamed",
      from: "Provider more info",
      to: "Provide more user info",
    });
  });

  it("sets a field of either tracker by the same steps: names to ids, the target read once, one mutation", async () => {
    let reads = 0;
    const unused = () => Promise.reject(new Error("not sent"));
    const context = fieldContext(unused, "g/t", 12, () => {
      reads++;
      return Promise.resolve({ id: "W1" });
    });
    const pick = pickHandler<{ id: string }>(
      { what: "milestone", choices: () => Promise.resolve([{ id: "M1", name: "May" }]) },
      (target, ids) => ({ mutation: "change", inputType: "ChangeInput", input: { id: target.id, ids } }),
    );
    assert.deepEqual(await optionsOf(pick, context, "milestone"), ["May"]);
    assert.deepEqual(await writeOf(pick, context, "milestone", ["May"]), {
      mutation: "change",
      inputType: "ChangeInput",
      input: { id: "W1", ids: ["M1"] },
    });
    await writeOf(pick, context, "milestone", []);
    assert.equal(reads, 1, "the target is read when asked for, and once");
    await assert.rejects(writeOf(pick, context, "milestone", "May"), /takes a list of values/);
    await assert.rejects(writeOf(pick, context, "milestone", ["April"]), /April is no milestone/);
    const typed = valueHandler<{ id: string }>((target, value) => ({
      mutation: "set",
      inputType: "SetInput",
      input: { id: target.id, value },
    }));
    assert.deepEqual(await writeOf(typed, context, "weight", 3), { mutation: "set", inputType: "SetInput", input: { id: "W1", value: 3 } });
    await assert.rejects(optionsOf(typed, context, "weight"), /weight is no field to choose from/);
  });

  it("sends a mutation as asked and throws what the host refused", async () => {
    const write = { mutation: "change", inputType: "ChangeInput", input: { id: "W1" } };
    const asked: { query: string; variables: object }[] = [];
    const answering = (data: unknown) => (query: string, variables: object) => {
      asked.push({ query, variables });
      return Promise.resolve(data);
    };
    await sendMutation(answering({ change: { clientMutationId: null } }), write, "clientMutationId");
    assert.deepEqual(asked, [
      { query: "mutation($input: ChangeInput!) { change(input: $input) { clientMutationId } }", variables: { input: { id: "W1" } } },
    ]);
    assert.deepEqual(await sendMutation(answering({ change: { issue: { iid: "4" }, errors: [] } }), write, "issue { iid } errors"), {
      issue: { iid: "4" },
      errors: [],
    });
    await assert.rejects(sendMutation(answering({ change: { errors: ["No", "Other"] } }), write, "errors"), /No; Other/);
    await assert.rejects(sendMutation(answering({ change: null }), write, "errors"), /answered the change with nothing/);
  });

  it("puts a change in GitHub's words", () => {
    // As it is sent: what is left out stays out of the request.
    const sent = (change: Parameters<typeof toGitHubInput>[1]): unknown => JSON.parse(JSON.stringify(toGitHubInput("I1", change)));
    assert.deepEqual(sent({ title: "T", body: "B" }), { id: "I1", title: "T", body: "B" });
    assert.deepEqual(sent({ state: "closed" }), { id: "I1", state: "CLOSED" });
    assert.deepEqual(sent({ state: "open" }), { id: "I1", state: "OPEN" });
  });

  it("puts the change of a field in GitHub's words, by the ids of its values", () => {
    const target = { id: "I1", parentId: "P0" };
    const write = (fieldId: string, ids: string[]) => GITHUB_FIELD_HANDLERS[fieldId].write(target, ids, ids);
    const update = (input: object) => ({ mutation: "updateIssue", inputType: "UpdateIssueInput", input });
    assert.deepEqual(write("labels", ["L1"]), update({ id: "I1", labelIds: ["L1"] }));
    assert.deepEqual(write("assignees", []), update({ id: "I1", assigneeIds: [] }));
    assert.deepEqual(write("milestone", ["m3"]), update({ id: "I1", milestoneId: "m3" }));
    assert.deepEqual(write("milestone", []), update({ id: "I1", milestoneId: null }));
    assert.deepEqual(write("type", ["T1"]), {
      mutation: "updateIssueIssueType",
      inputType: "UpdateIssueIssueTypeInput",
      input: { issueId: "I1", issueTypeId: "T1" },
    });
    assert.deepEqual(write("type", []).input, { issueId: "I1", issueTypeId: null });
    assert.deepEqual(write("parent", ["P1"]), {
      mutation: "addSubIssue",
      inputType: "AddSubIssueInput",
      input: { issueId: "P1", subIssueId: "I1", replaceParent: true },
    });
    assert.deepEqual(write("parent", []), {
      mutation: "removeSubIssue",
      inputType: "RemoveSubIssueInput",
      input: { issueId: "P0", subIssueId: "I1" },
    });
    assert.throws(() => GITHUB_FIELD_HANDLERS.parent.write({ id: "I1" }, [], []), /no parent/);
    assert.equal(GITHUB_FIELD_HANDLERS.weight, undefined, "a field GitHub does not have");
  });

  it("sets an issue field of the organization by the type it is", () => {
    const target = { id: "I1" };
    const field = (typename: string) => gitHubIssueFieldOf({ __typename: typename, id: "F1", name: "Priority" });
    const set = (entry: object) => ({
      mutation: "setIssueFieldValue",
      inputType: "SetIssueFieldValueInput",
      input: { issueId: "I1", issueFields: [{ fieldId: "F1", ...entry }] },
    });
    assert.deepEqual(field("IssueFieldText").write(target, "soon", []), set({ textValue: "soon" }));
    assert.deepEqual(field("IssueFieldText").write(target, null, []), set({ delete: true }));
    assert.deepEqual(field("IssueFieldNumber").write(target, 2.5, []), set({ numberValue: 2.5 }));
    assert.deepEqual(field("IssueFieldNumber").write(target, null, []), set({ delete: true }));
    assert.throws(() => field("IssueFieldNumber").write(target, "2", []), /takes a number/);
    assert.deepEqual(field("IssueFieldDate").write(target, "2026-11-30", []), set({ dateValue: "2026-11-30" }));
    assert.deepEqual(field("IssueFieldSingleSelect").write(target, ["High"], ["O1"]), set({ singleSelectOptionId: "O1" }));
    assert.deepEqual(field("IssueFieldSingleSelect").write(target, [], []), set({ delete: true }));
    assert.deepEqual(field("IssueFieldMultiSelect").write(target, ["a", "b"], ["O1", "O2"]), set({ multiSelectOptionIds: ["O1", "O2"] }));
    assert.deepEqual(field("IssueFieldMultiSelect").write(target, [], []), set({ delete: true }));
    assert.ok(field("IssueFieldSingleSelect").pick && field("IssueFieldMultiSelect").pick, "selects list their options");
    assert.equal(field("IssueFieldText").pick, undefined);
    assert.throws(() => field("IssueFieldSomethingNew"), /does not know/);
  });

  it("lists the fields a GitHub issue has, each of the extras only where the host has it", () => {
    const parent = { number: 7, title: "Epic one", repository: { nameWithOwner: "o/epics" } };
    assert.equal(gitHubParentName(parent), "Epic one (o/epics#7)");
    const issue = {
      ...githubIssue,
      milestone: { title: "May" },
      participants: { nodes: [{ login: "mira", avatarUrl: "https://avatars.example.com/u/1" }, null] },
    };
    const summary = (extras: Parameters<typeof toGitHubFields>[1]) =>
      toGitHubFields(issue, extras).map(({ id, name, editable, ...rest }) => [id, name, editable, rest]);
    assert.deepEqual(summary({}), [
      ["assignees", "Assignees", true, { kind: "pick", value: ["jonas", "lena"], several: true, shown: "people" }],
      ["labels", "Labels", true, { kind: "pick", value: ["bug", "terminals"], several: true, shown: "labels" }],
      ["milestone", "Milestone", true, { kind: "pick", value: ["May"], several: false, shown: "text" }],
      ["participants", "Participants", false, { kind: "pick", value: ["mira"], several: true, shown: "people" }],
    ]);
    assert.deepEqual(
      toGitHubFields(
        { ...issue, participants: undefined },
        {
          issueType: { current: "Bug", available: ["Bug", "Task"], editable: false },
          parent,
          issueFields: {
            editable: true,
            pinned: ["Areas", "Priority", "Customer"],
            definitions: [
              { __typename: "IssueFieldSingleSelect", id: "F1", name: "Priority", options: [{ id: "O1", name: "High" }] },
              { __typename: "IssueFieldMultiSelect", id: "F2", name: "Areas", options: [{ id: "O2", name: "UI" }] },
              { __typename: "IssueFieldText", id: "F3", name: "Customer" },
              { __typename: "IssueFieldNumber", id: "F4", name: "Estimate" },
              { __typename: "IssueFieldDate", id: "F5", name: "Target" },
              { __typename: "IssueFieldFuture", id: "F6", name: "Unknown" },
              { __typename: "IssueFieldText", id: "F7", name: "Not pinned, not held" },
            ],
            values: [
              { field: { name: "Priority" }, value: "High" },
              { field: { name: "Areas" }, options: [{ id: "O2", name: "UI" }] },
              { field: { name: "Estimate" }, value: 5 },
              { field: { name: "Target" }, value: "2026-11-30T00:00:00Z" },
            ],
          },
        },
      ).map(({ id, editable, ...rest }) => [id, editable, rest]),
      [
        ["assignees", true, { name: "Assignees", kind: "pick", value: ["jonas", "lena"], several: true, shown: "people" }],
        ["labels", true, { name: "Labels", kind: "pick", value: ["bug", "terminals"], several: true, shown: "labels" }],
        ["type", false, { name: "Type", kind: "pick", value: ["Bug"], several: false, shown: "text" }],
        ["milestone", true, { name: "Milestone", kind: "pick", value: ["May"], several: false, shown: "text" }],
        ["parent", true, { name: "Parent", kind: "pick", value: ["Epic one (o/epics#7)"], several: false, shown: "text" }],
        ["F2", true, { name: "Areas", kind: "pick", value: ["UI"], several: true, shown: "labels" }],
        ["F1", true, { name: "Priority", kind: "pick", value: ["High"], several: false, shown: "text" }],
        ["F3", true, { name: "Customer", kind: "text", value: undefined }],
        ["F4", true, { name: "Estimate", kind: "number", value: 5 }],
        ["F5", true, { name: "Target", kind: "date", value: "2026-11-30" }],
      ],
      "the pinned fields in their order, held or not, then the others that hold a value",
    );
    assert.deepEqual(
      summary({ issueType: { current: null, available: [], editable: true }, parent: null }).map(([id]) => id),
      ["assignees", "labels", "milestone", "parent", "participants"],
      "a repository without types has no type field, an issue with no parent still offers one",
    );
  });

  it("has a handler for each field a GitHub issue lists as changeable, and for no other", () => {
    const definitions = [
      { __typename: "IssueFieldSingleSelect", id: "F1", name: "Priority", options: [{ id: "O1", name: "High" }] },
      { __typename: "IssueFieldMultiSelect", id: "F2", name: "Areas", options: [{ id: "O2", name: "UI" }] },
      { __typename: "IssueFieldText", id: "F3", name: "Customer" },
      { __typename: "IssueFieldNumber", id: "F4", name: "Estimate" },
      { __typename: "IssueFieldDate", id: "F5", name: "Target" },
    ];
    const listed = toGitHubFields(
      { ...githubIssue, participants: { nodes: [] } },
      {
        issueType: { current: "Bug", available: ["Bug"], editable: true },
        parent: null,
        issueFields: { editable: true, pinned: definitions.map((definition) => definition.name), values: [], definitions },
      },
    );
    assert.equal(listed.length, 11);
    for (const field of listed) {
      const handler = Object.hasOwn(GITHUB_FIELD_HANDLERS, field.id)
        ? GITHUB_FIELD_HANDLERS[field.id]
        : definitions.filter((definition) => definition.id === field.id).map(gitHubIssueFieldOf)[0];
      assert.equal(handler !== undefined, field.editable, field.id);
      if (handler) {
        assert.equal(handler.pick !== undefined, field.kind === "pick", `${field.id} is picked from a list`);
      }
    }
  });

  it("keeps an issue only with all of a filter's labels, as GitHub's own filter takes any", () => {
    assert.equal(carriesAll(githubIssue, []), true);
    assert.equal(carriesAll(githubIssue, ["terminals", "bug"]), true);
    assert.equal(carriesAll(githubIssue, ["bug", "docs"]), false);
  });

  it("offers an upload where the host takes one from a token, and what it takes", () => {
    assert.ok(github.uploads("github.com")?.extensions?.includes("png"));
    assert.ok(github.uploads("tenant.ghe.com")?.extensions?.includes("mp4"));
    assert.equal(github.uploads("github.example.com"), undefined, "an Enterprise Server has none");
    assert.deepEqual(gitlab.uploads("gitlab.example.com"), {}, "any file");
  });

  it("refuses what GitHub takes no upload of, without asking it", async () => {
    const tracker = { host: "github.com", token: "t", path: "o/r" };
    await assert.rejects(() => github.uploadFile(tracker, "a.pdf", Buffer.from("x")), /only images and videos/);
  });

  it("reads what a GraphQL answer refused, under its status of 200", () => {
    assert.equal(graphqlError({}), undefined);
    assert.equal(graphqlError({ errors: [] }), undefined);
    assert.equal(graphqlError({ errors: [{ message: "No permission" }, { message: "Other" }] }), "No permission; Other");
    assert.equal(graphqlError({ errors: [{}] }), "The host refused the request");
  });

  it("shows a GitHub upload by its kind", () => {
    assert.equal(contentTypeOf("A.PNG"), "image/png");
    assert.equal(contentTypeOf("a.txt"), undefined);
    assert.equal(uploadMarkdown("a[1].png", "https://x/a", "image/png"), "![a\\[1\\].png](https://x/a)");
    assert.equal(uploadMarkdown("a.mp4", "https://x/a", "video/mp4"), "https://x/a");
  });

  it("leaves out what GitLab noted itself, and reads a deleted account's comment as ghost's", () => {
    const author = { username: "anna" };
    assert.deepEqual(
      toGitLabNotes([
        { id: "n1", system: true, internal: false, author, createdAt: "a", body: "added label" },
        { id: "n2", system: false, internal: false, author, createdAt: "b", body: "Comment" },
        { id: "n3", system: false, internal: false, author: null, createdAt: "c", body: "Gone" },
        { id: "n4", system: false, internal: true, author, createdAt: "d", body: "Between us" },
      ]),
      [
        { id: "n2", author: "anna", createdAt: "b", body: "Comment", internal: false },
        { id: "n3", author: "ghost", createdAt: "c", body: "Gone", internal: false },
        { id: "n4", author: "anna", createdAt: "d", body: "Between us", internal: true },
      ],
    );
  });

  it("finds a host and path in every kind of remote url", () => {
    const parsed = { host: "github.com", path: "o/r" };
    assert.deepEqual(parseRemoteUrl("https://github.com/o/r.git"), parsed);
    assert.deepEqual(parseRemoteUrl("https://user@github.com/o/r/"), parsed);
    assert.deepEqual(parseRemoteUrl("git@github.com:o/r.git"), parsed);
    assert.deepEqual(parseRemoteUrl("ssh://git@github.com:22/o/r.git"), parsed);
    assert.deepEqual(parseRemoteUrl("https://gitlab.example.com:8443/g/s/t.git"), { host: "gitlab.example.com:8443", path: "g/s/t" });
    assert.equal(parseRemoteUrl("/home/me/repo.git"), undefined);
    assert.equal(parseRemoteUrl("C:\\repos\\r.git"), undefined);
    assert.equal(parseRemoteUrl("file:///home/me/repo.git"), undefined);
  });

  describe("reached through an account", () => {
    const account = (id: string, host = "github.com"): ProviderAccount => ({ id, provider: "github", host, user: id });
    const accountsOf = (...accounts: ProviderAccount[]): IssueAccounts => ({
      list: () => accounts,
      token: async (id) => (id === "unreadable" ? undefined : `token-${id}`),
    });
    const repositoryAt = (root: string, url?: string): IssueRepository => ({
      at: { path: root },
      started: () => Promise.resolve(),
      getState: () => ({ remotes: url === undefined ? [] : [{ name: "origin", branches: [], mergedBranches: [], url }] }),
    });
    const ORIGIN = "git@github.com:o/r.git";

    it("waits for a repository still opening, whose state holds no remotes yet", async () => {
      const root = tempDir("tet-issues-");
      let read = false;
      const opening: IssueRepository = {
        ...repositoryAt(root, ORIGIN),
        started: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          read = true;
        },
        getState: () => (read ? repositoryAt(root, ORIGIN).getState() : { remotes: [] }),
      };
      const answer = await onTracker(accountsOf(account("a")), opening, async (_provider, { host }) => host);
      assert.equal(answer, "github.com");
    });

    it("hands a failure on to the next account of the host, and tells the first's reason when all fail", async () => {
      const root = tempDir("tet-issues-");
      const seen: string[] = [];
      const accounts = accountsOf(account("a"), account("other", "gitlab.com"), account("b"));
      const answer = await onTracker(accounts, repositoryAt(root, ORIGIN), async (_provider, { host, token, path }) => {
        seen.push(token);
        if (token === "token-a") {
          throw new Error("first");
        }
        return `${host} ${path}`;
      });
      assert.equal(answer, "github.com o/r");
      assert.deepEqual(seen, ["token-a", "token-b"]);
      await assert.rejects(
        () =>
          onTracker(accountsOf(account("a"), account("b")), repositoryAt(root, ORIGIN), async (_provider, { token }) => {
            throw new Error(token);
          }),
        /token-a/,
      );
    });

    it("says whose token the host refused, and what to do; any other status in the host's words", async () => {
      const root = tempDir("tet-issues-");
      const answering = (status: number) => async (): Promise<string> => {
        throw new ApiError(status, `${status} from the host`);
      };
      const accounts = accountsOf(account("a"));
      await assert.rejects(
        () => onTracker(accounts, repositoryAt(root, ORIGIN), answering(401)),
        /github\.com refused the token of a.*add the account again/,
      );
      await assert.rejects(() => onTracker(accounts, repositoryAt(root, ORIGIN), answering(403)), /^Error: 403 from the host$/);
    });

    it("writes through the next account only where the first does not reach the tracker", async () => {
      const root = tempDir("tet-issues-");
      const accounts = accountsOf(account("a"), account("b"));
      const failingFirst =
        (status: number, seen: string[]) =>
        async (_provider: unknown, { token }: Tracker) => {
          seen.push(token);
          if (token === "token-a") {
            throw new ApiError(status, `${status} from the host`);
          }
          return "written";
        };
      for (const status of [401, 404]) {
        const seen: string[] = [];
        assert.equal(await writeOnTracker(accounts, repositoryAt(root, ORIGIN), failingFirst(status, seen)), "written");
        assert.deepEqual(seen, ["token-a", "token-b"]);
      }
      const seen: string[] = [];
      await assert.rejects(() => writeOnTracker(accounts, repositoryAt(root, ORIGIN), failingFirst(403, seen)), /403 from the host/);
      assert.deepEqual(seen, ["token-a"], "another name is not used for what this one may not do");
    });

    it("tells what is missing: a remote, an account, a token it can read", async () => {
      const root = tempDir("tet-issues-");
      const call = async (): Promise<string> => "called";
      await assert.rejects(() => onTracker(accountsOf(account("a")), repositoryAt(root), call), /no remote/);
      await assert.rejects(
        () => onTracker(accountsOf(), repositoryAt(root, ORIGIN), call),
        (error: unknown) => error instanceof NoAccountError && error.host === "github.com",
      );
      await assert.rejects(() => onTracker(accountsOf(account("unreadable")), repositoryAt(root, ORIGIN), call), /could not be read/);
    });

    it("reads from tet.json's source, on the remote's host", async () => {
      const root = tempDir("tet-issues-");
      fs.writeFileSync(path.join(root, "tet.json"), '{"issues": {"source": "g/tracker"}}');
      const read = await onTracker(accountsOf(account("a")), repositoryAt(root, ORIGIN), async (_provider, { host, path }) => {
        return `${host} ${path}`;
      });
      assert.equal(read, "github.com g/tracker");
    });

    it("refuses a source that is no path, without asking the tracker", async () => {
      const root = tempDir("tet-issues-");
      await assert.rejects(() => setIssueSource(accountsOf(), repositoryAt(root, ORIGIN), "a/../b"), /Not a repository path/);
      assert.equal(fs.existsSync(path.join(root, "tet.json")), false);
    });

    it("takes a url for the source as its path", async (t) => {
      const root = tempDir("tet-issues-");
      const asked: string[] = [];
      t.mock.method(PROVIDERS.github, "listLabels", async ({ path }: Tracker) => {
        asked.push(path);
        return [];
      });
      const saved = await setIssueSource(accountsOf(account("a")), repositoryAt(root, ORIGIN), " https://GitHub.com/g/s/tracker.git/ ");
      assert.equal(saved, "g/s/tracker");
      assert.deepEqual(asked, ["g/s/tracker"]);
      assert.equal(await readIssueSource(root), "g/s/tracker");
    });

    it("refuses a url on another host than the remote's, without asking the tracker", async () => {
      const root = tempDir("tet-issues-");
      await assert.rejects(
        () => setIssueSource(accountsOf(account("a")), repositoryAt(root, ORIGIN), "https://gitlab.example.com/g/tracker"),
        /Not on this repository's host, github\.com/,
      );
      assert.equal(fs.existsSync(path.join(root, "tet.json")), false);
    });

    it("removes the source without asking the tracker", async () => {
      const root = tempDir("tet-issues-");
      fs.writeFileSync(path.join(root, "tet.json"), '{"issues": {"source": "g/tracker"}}');
      await setIssueSource(accountsOf(), repositoryAt(root), "  ");
      assert.equal(await readIssueSource(root), undefined);
    });
  });

  it("writes an issue as a file that says where its text comes from", () => {
    const markdown = issueMarkdown({
      ...toGitHubIssue(githubIssue),
      provider: "github",
      fields: [
        { id: "assignees", name: "Assignees", editable: true, kind: "pick", several: true, shown: "people", value: ["jonas", "lena"] },
        { id: "labels", name: "Labels", editable: true, kind: "pick", several: true, shown: "labels", value: ["bug", "terminals"] },
        { id: "milestone", name: "Milestone", editable: true, kind: "pick", several: false, shown: "text", value: ["May"] },
        { id: "weight", name: "Weight", editable: true, kind: "number", value: 3 },
        { id: "confidential", name: "Confidential", editable: true, kind: "flag", value: true },
      ],
      body: "Text",
      notes: [{ id: "n1", author: "lena", createdAt: "2026-10-03", body: "Comment" }],
      events: [{ actor: "lena", createdAt: "2026-10-03", kind: "closed" }],
    });
    assert.ok(markdown.startsWith("# #412 Focus is lost\n\nCopied from https://github.com/o/r/issues/412."));
    for (const part of [
      "- Author: mira",
      "- Assignees: jonas, lena",
      "- Milestone: May",
      "- Labels: bug, terminals",
      "- Weight: 3",
      "- Confidential: yes",
      "\nText\n",
      "## Comments",
      "### lena, 2026-10-03",
      "Comment\n",
    ]) {
      assert.ok(markdown.includes(part), part);
    }
    const bare = issueMarkdown({
      ...toGitHubIssue({ ...githubIssue, assignees: { nodes: [] }, labels: { nodes: [] } }),
      provider: "github",
      fields: [
        { id: "assignees", name: "Assignees", editable: true, kind: "pick", several: true, shown: "people", value: [] },
        { id: "weight", name: "Weight", editable: true, kind: "number", value: undefined },
        { id: "confidential", name: "Confidential", editable: true, kind: "flag", value: false },
      ],
      body: "",
      notes: [],
      events: [],
    });
    assert.ok(!bare.includes("Assignees") && !bare.includes("Weight") && !bare.includes("Confidential") && !bare.includes("Comments"));
  });
});

describe("the accounts kept for the providers", () => {
  const withStore = (): { root: string; store: AccountStore } => {
    fakeSafeStorage();
    const root = tempDir("tet-accounts-");
    return { root, store: new AccountStore(root) };
  };

  it("lists an account without its token, and gives the token back decrypted", async () => {
    const { root, store } = withStore();
    const account = await store.add("github", "github.com", "octocat", "secret-token");
    assert.equal("token" in store.list()[0], false);
    assert.equal(store.get(account.id)?.user, "octocat");
    assert.equal(await store.token(account.id), "secret-token");
    assert.ok(!fs.readFileSync(path.join(root, "provider-accounts.json"), "utf8").includes("secret-token"), "kept sealed");
  });

  it("replaces the token of the same user on the same host, never adding a second row", async () => {
    const { store } = withStore();
    const first = await store.add("github", "github.com", "octocat", "old");
    const again = await store.add("github", "github.com", "octocat", "new");
    await store.add("gitlab", "github.com", "octocat", "other");
    assert.equal(again.id, first.id);
    assert.equal(store.list().length, 2);
    assert.equal(await store.token(first.id), "new");
  });

  it("remembers the namespace of an account, and is a no-op for one that is gone", async () => {
    const { store } = withStore();
    const { id } = await store.add("gitlab", "gitlab.example.com", "tanuki", "t");
    store.setNamespace(id, "my-group");
    store.setNamespace("unknown", "x");
    assert.equal(store.get(id)?.namespace, "my-group");
    assert.equal(store.list().length, 1);
  });

  it("removes an account with its token, and a new store reads the file back", async () => {
    const { root, store } = withStore();
    const keep = await store.add("github", "github.com", "a", "ta");
    const drop = await store.add("github", "github.com", "b", "tb");
    store.remove(drop.id);
    const reopened = new AccountStore(root);
    assert.deepEqual(
      reopened.list().map((account) => account.id),
      [keep.id],
    );
    assert.equal(await reopened.token(keep.id), "ta");
    assert.equal(await reopened.token(drop.id), undefined);
  });

  it("leaves out rows of a provider it does not know, and keeps nothing where the OS offers no encryption", async () => {
    const root = tempDir("tet-accounts-");
    fs.writeFileSync(
      path.join(root, "provider-accounts.json"),
      JSON.stringify([
        { id: "1", provider: "github", host: "github.com", user: "a", token: "x" },
        { id: "2", provider: "bitbucket", host: "bitbucket.org", user: "b", token: "y" },
        { id: "3", provider: "github", host: "github.com", user: "c", token: "z", namespace: 7 },
      ]),
    );
    fakeSafeStorage();
    assert.deepEqual(
      new AccountStore(root).list().map((account) => account.id),
      ["1"],
    );
    fakeSafeStorage(false);
    const store = new AccountStore(root);
    await assert.rejects(() => store.add("github", "github.com", "d", "t"));
    assert.equal(store.list().length, 1, "the row is not kept for a token that could not be sealed");
    assert.deepEqual(Object.keys(PROVIDERS).sort(), ["github", "gitlab"]);
  });
});

describe("the repositories cache", () => {
  const repo = { fullName: "octocat/hello", name: "hello", cloneUrl: "https://github.com/octocat/hello.git" };

  it("keeps an account's listing across restarts and drops it with the account", () => {
    const root = tempDir("tet-repos-cache-");
    const cache = new RepoCache(root);
    assert.equal(cache.get("a"), undefined);
    cache.set("a", [repo]);
    assert.deepEqual(new RepoCache(root).get("a"), [repo]);
    cache.remove("a");
    assert.equal(new RepoCache(root).get("a"), undefined);
  });

  it("reads a damaged file defensively", () => {
    const root = tempDir("tet-repos-cache-");
    fs.writeFileSync(path.join(root, "repos-cache.json"), JSON.stringify({ a: [repo, { fullName: 1 }], b: "x" }));
    const cache = new RepoCache(root);
    assert.deepEqual(cache.get("a"), [repo]);
    assert.equal(cache.get("b"), undefined);
  });
});
