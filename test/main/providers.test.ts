import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AccountStore } from "../../src/main/providers/accounts";
import { PROVIDERS } from "../../src/main/providers";
import {
  contentTypeOf,
  github,
  graphqlError,
  issuesUrl as gitHubIssuesUrl,
  toEvents as toGitHubEvents,
  toIssue as toGitHubIssue,
  toIssueUpdate as toGitHubUpdate,
  uploadMarkdown,
} from "../../src/main/providers/github";
import {
  gitlab,
  issuesUrl as gitLabIssuesUrl,
  toEvents as toGitLabEvents,
  toIssue as toGitLabIssue,
  toIssueUpdate,
  toNotes as toGitLabNotes,
  uploadOf,
} from "../../src/main/providers/gitlab";
import {
  issueMarkdown,
  onTracker,
  parseRemoteUrl,
  setIssueSource,
  writeOnTracker,
  type IssueAccounts,
  type IssueRepository,
} from "../../src/main/providers/issues";
import { ApiError } from "../../src/main/providers/provider";
import { RepoCache } from "../../src/main/providers/repo-cache";
import { readIssueSource } from "../../src/main/store/tet-json";
import type { ProviderAccount } from "../../src/shared/types/providers";
import { fakeSafeStorage, tempDir } from "../helpers";

/** providers/: the accounts kept for the providers, and the issues read through them. */

describe("the issues of a tracker", () => {
  const githubIssue = {
    number: 412,
    title: "Focus is lost",
    html_url: "https://github.com/o/r/issues/412",
    state: "open",
    user: { login: "mira", avatar_url: "https://avatars.example.com/u/1?v=4" },
    assignees: [
      { login: "jonas", avatar_url: "https://avatars.example.com/u/2?v=4" },
      { login: "lena", avatar_url: "https://avatars.example.com/u/3" },
    ],
    comments: 3,
    created_at: "2026-10-01T10:00:00Z",
    labels: [{ name: "bug" }, "terminals"],
    body: "Text",
  };
  const gitlabIssue = {
    iid: 12,
    title: "VAT",
    web_url: "https://gitlab.example.com/g/t/-/issues/12",
    state: "closed",
    author: { username: "anna", avatar_url: null },
    assignees: [],
    user_notes_count: 1,
    created_at: "2026-10-02T10:00:00Z",
    labels: ["type::bug"],
    description: null,
  };

  it("reads GitHub's and GitLab's records as one row", () => {
    assert.deepEqual(toGitHubIssue(githubIssue), {
      number: 412,
      title: "Focus is lost",
      url: "https://github.com/o/r/issues/412",
      open: true,
      author: "mira",
      assignee: "jonas",
      comments: 3,
      createdAt: "2026-10-01T10:00:00Z",
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
      comments: 1,
      createdAt: "2026-10-02T10:00:00Z",
      labels: ["type::bug"],
      avatars: {},
    });
    assert.equal(toGitHubIssue({ ...githubIssue, user: null }).author, "ghost");
    assert.equal(toGitHubIssue({ ...githubIssue, user: null }).avatars.ghost, undefined);
    assert.deepEqual(toGitLabIssue({ ...gitlabIssue, author: { username: "anna", avatar_url: "https://g/a.png" } }).avatars, {
      anna: "https://g/a.png",
    });
  });

  it("reads what happened to an issue off GitHub's timeline, leaving out what the tab does not draw", () => {
    const actor = { login: "mira", avatar_url: "https://a/1" };
    const created_at = "2026-10-01T10:00:00Z";
    const base = { actor: "mira", createdAt: created_at };
    assert.deepEqual(
      toGitHubEvents([
        { event: "commented", actor, created_at },
        { event: "closed", actor, created_at },
        { event: "reopened", actor: null, created_at },
        { event: "assigned", actor, created_at, assignee: actor },
        { event: "unassigned", actor, created_at, assignee: actor },
        { event: "labeled", actor, created_at, label: { name: "bug" } },
        { event: "unlabeled", actor, created_at, label: { name: "bug" } },
        { event: "milestoned", actor, created_at, milestone: { title: "May" } },
        { event: "demilestoned", actor, created_at, milestone: { title: "May" } },
        { event: "renamed", actor, created_at, rename: { from: "A", to: "B" } },
        { event: "cross-referenced", actor, created_at, source: { issue: { number: 7, title: "T", html_url: "https://h/7" } } },
        { event: "subscribed", actor, created_at },
      ]),
      [
        { ...base, kind: "closed" },
        { actor: "ghost", createdAt: created_at, kind: "reopened" },
        { ...base, kind: "assigned", login: "mira" },
        { ...base, kind: "unassigned", login: "mira" },
        { ...base, kind: "labeled", label: "bug" },
        { ...base, kind: "unlabeled", label: "bug" },
        { ...base, kind: "milestoned", milestone: "May" },
        { ...base, kind: "demilestoned", milestone: "May" },
        { ...base, kind: "renamed", from: "A", to: "B" },
        { ...base, kind: "linked", number: 7, title: "T", url: "https://h/7" },
      ],
    );
  });

  it("reads what happened to an issue off GitLab's records and system notes", () => {
    const user = { username: "anna", avatar_url: null };
    const created_at = "2026-10-01T10:00:00Z";
    const base = { actor: "anna", createdAt: created_at };
    assert.deepEqual(
      toGitLabEvents(
        [
          { id: 1, system: true, author: user, created_at, body: "assigned to @anna" },
          { id: 2, system: false, author: user, created_at, body: "Comment" },
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
    const hub = new URL(gitHubIssuesUrl("github.com", "o/r", filter));
    assert.equal(hub.origin + hub.pathname, "https://api.github.com/repos/o/r/issues");
    assert.equal(hub.searchParams.get("state"), "closed");
    assert.equal(hub.searchParams.get("creator"), "mira");
    assert.equal(hub.searchParams.get("assignee"), "jonas");
    assert.equal(hub.searchParams.get("labels"), "bug,ui");
    assert.equal(new URL(gitHubIssuesUrl("github.com", "o/r", { labels: [] })).searchParams.get("state"), "all");

    const lab = new URL(gitLabIssuesUrl("gitlab.example.com", "g/s/t", filter));
    assert.ok(lab.href.startsWith("https://gitlab.example.com/api/v4/projects/g%2Fs%2Ft/issues?"));
    assert.equal(lab.searchParams.get("state"), "closed");
    assert.equal(lab.searchParams.get("author_username"), "mira");
    assert.equal(lab.searchParams.get("assignee_username"), "jonas");
    assert.equal(lab.searchParams.get("labels"), "bug,ui");
    assert.equal(new URL(gitLabIssuesUrl("gitlab.example.com", "g/t", { state: "open", labels: [] })).searchParams.get("state"), "opened");
    assert.equal(new URL(gitLabIssuesUrl("gitlab.example.com", "g/t", { labels: [] })).searchParams.has("state"), false);
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

  it("puts a change in GitLab's words, refusing a login no member has", () => {
    const members = [{ id: 7, username: "anna", avatar_url: null }];
    // As it is sent: what is left out stays out of the request.
    const sent = (...args: Parameters<typeof toIssueUpdate>): unknown => JSON.parse(JSON.stringify(toIssueUpdate(...args)));
    assert.deepEqual(sent({ labels: ["a", "b"] }, []), { labels: "a,b" });
    assert.deepEqual(sent({ assignees: ["anna"] }, members), { assignee_ids: [7] });
    assert.deepEqual(sent({ assignees: [], labels: [] }, []), { labels: "", assignee_ids: [] });
    assert.deepEqual(sent({ title: "T", body: "B" }, []), { title: "T", description: "B" });
    assert.deepEqual(sent({ state: "closed" }, []), { state_event: "close" });
    assert.deepEqual(sent({ state: "open" }, []), { state_event: "reopen" });
    assert.deepEqual(sent({ milestone: { id: 3, title: "M" } }, []), { milestone_id: 3 });
    assert.deepEqual(sent({ milestone: null }, []), { milestone_id: 0 });
    assert.throws(() => toIssueUpdate({ assignees: ["tom"] }, members), /tom is no member/);
  });

  it("puts a change in GitHub's words", () => {
    const sent = (change: Parameters<typeof toGitHubUpdate>[0]): unknown => JSON.parse(JSON.stringify(toGitHubUpdate(change)));
    assert.deepEqual(sent({ title: "T", state: "closed", labels: ["a"] }), { title: "T", state: "closed", labels: ["a"] });
    assert.deepEqual(sent({ milestone: { id: 3, title: "M" } }), { milestone: 3 });
    assert.deepEqual(sent({ milestone: null }), { milestone: null });
    assert.deepEqual(sent({ assignees: [] }), { assignees: [] });
  });

  it("offers an upload where the host takes one from a token, and what it takes", () => {
    assert.ok(github.uploads("github.com")?.extensions?.includes("png"));
    assert.ok(github.uploads("tenant.ghe.com")?.extensions?.includes("mp4"));
    assert.equal(github.uploads("github.example.com"), undefined, "an Enterprise Server has none");
    assert.deepEqual(gitlab.uploads("gitlab.example.com"), {}, "any file");
  });

  it("refuses what GitHub takes no upload of, without asking it", async () => {
    await assert.rejects(() => github.uploadFile("github.com", "t", "o/r", "a.pdf", Buffer.from("x")), /only images and videos/);
  });

  it("reads what a GraphQL answer refused, under its status of 200", () => {
    assert.equal(graphqlError({}), undefined);
    assert.equal(graphqlError({ errors: [] }), undefined);
    assert.equal(graphqlError({ errors: [{ message: "No permission" }, { message: "Other" }] }), "No permission; Other");
    assert.equal(graphqlError({ errors: [{}] }), "GitHub refused the request");
  });

  it("shows a GitHub upload by its kind", () => {
    assert.equal(contentTypeOf("A.PNG"), "image/png");
    assert.equal(contentTypeOf("a.txt"), undefined);
    assert.equal(uploadMarkdown("a[1].png", "https://x/a", "image/png"), "![a\\[1\\].png](https://x/a)");
    assert.equal(uploadMarkdown("a.mp4", "https://x/a", "video/mp4"), "https://x/a");
  });

  it("leaves out what GitLab noted itself", () => {
    const author = { username: "anna", avatar_url: null };
    assert.deepEqual(
      toGitLabNotes([
        { id: 1, system: true, author, created_at: "a", body: "added label" },
        { id: 2, system: false, author, created_at: "b", body: "Comment" },
      ]),
      [{ id: 2, author: "anna", createdAt: "b", body: "Comment" }],
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
      const answer = await onTracker(accountsOf(account("a")), opening, async (_provider, host) => host);
      assert.equal(answer, "github.com");
    });

    it("hands a failure on to the next account of the host, and tells the first's reason when all fail", async () => {
      const root = tempDir("tet-issues-");
      const seen: string[] = [];
      const accounts = accountsOf(account("a"), account("other", "gitlab.com"), account("b"));
      const answer = await onTracker(accounts, repositoryAt(root, ORIGIN), async (_provider, host, token, path) => {
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
          onTracker(accountsOf(account("a"), account("b")), repositoryAt(root, ORIGIN), async (_provider, _host, token) => {
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
      const failingFirst = (status: number, seen: string[]) => async (_provider: unknown, _host: string, token: string) => {
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
      await assert.rejects(() => onTracker(accountsOf(), repositoryAt(root, ORIGIN), call), /No account for github\.com/);
      await assert.rejects(() => onTracker(accountsOf(account("unreadable")), repositoryAt(root, ORIGIN), call), /could not be read/);
    });

    it("reads from tet.json's source, on the remote's host", async () => {
      const root = tempDir("tet-issues-");
      fs.writeFileSync(path.join(root, "tet.json"), '{"issues": "g/tracker"}');
      const read = await onTracker(accountsOf(account("a")), repositoryAt(root, ORIGIN), async (_provider, host, _token, source) => {
        return `${host} ${source}`;
      });
      assert.equal(read, "github.com g/tracker");
    });

    it("refuses a source that is no path, without asking the tracker", async () => {
      const root = tempDir("tet-issues-");
      await assert.rejects(() => setIssueSource(accountsOf(), repositoryAt(root, ORIGIN), "a/../b"), /Not a repository path/);
      assert.equal(fs.existsSync(path.join(root, "tet.json")), false);
    });

    it("removes the source without asking the tracker", async () => {
      const root = tempDir("tet-issues-");
      fs.writeFileSync(path.join(root, "tet.json"), '{"issues": "g/tracker"}');
      await setIssueSource(accountsOf(), repositoryAt(root), "  ");
      assert.equal(await readIssueSource(root), undefined);
    });
  });

  it("writes an issue as a file that says where its text comes from", () => {
    const markdown = issueMarkdown({
      ...toGitHubIssue(githubIssue),
      assignees: ["jonas", "lena"],
      milestone: "May",
      body: "Text",
      notes: [{ id: 1, author: "lena", createdAt: "2026-10-03", body: "Comment" }],
      events: [{ actor: "lena", createdAt: "2026-10-03", kind: "closed" }],
    });
    assert.ok(markdown.startsWith("# #412 Focus is lost\n\nCopied from https://github.com/o/r/issues/412."));
    for (const part of [
      "- Author: mira",
      "- Assignees: jonas, lena",
      "- Milestone: May",
      "- Labels: bug, terminals",
      "\nText\n",
      "## Comments",
      "### lena, 2026-10-03",
      "Comment\n",
    ]) {
      assert.ok(markdown.includes(part), part);
    }
    const bare = issueMarkdown({
      ...toGitHubIssue({ ...githubIssue, assignees: [], labels: [] }),
      assignees: [],
      body: "",
      notes: [],
      events: [],
    });
    assert.ok(!bare.includes("Assignees") && !bare.includes("Milestone") && !bare.includes("Labels") && !bare.includes("Comments"));
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
