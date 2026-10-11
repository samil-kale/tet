import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { net } from "electron";
import { AccountStore } from "../../src/main/providers/accounts";
import { github } from "../../src/main/providers/github";
import { gitlab } from "../../src/main/providers/gitlab";
import { PROVIDERS } from "../../src/main/providers";
import { fakeSafeStorage, tempDir } from "../helpers";

/** providers/: GitHub's and GitLab's REST calls over electron's net, and the accounts kept for them. */

interface Call {
  url: string;
  headers: Record<string, string>;
}

const originalFetch = (net as { fetch?: unknown }).fetch;
afterEach(() => {
  (net as { fetch?: unknown }).fetch = originalFetch;
});

/** `net.fetch` answering each request from `answer`, and the requests it saw. */
function serving(answer: (url: URL) => Response): Call[] {
  const calls: Call[] = [];
  (net as { fetch?: unknown }).fetch = (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return Promise.resolve(answer(new URL(url)));
  };
  return calls;
}

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

describe("GitHub", () => {
  it("asks github.com's own API subdomain, and an enterprise host under /api/v3, with the token as a bearer", async () => {
    const calls = serving(() => json({ login: "octocat" }));
    assert.equal(await github.validate("github.com", "tok"), "octocat");
    assert.equal(await github.validate("git.example.com", "tok"), "octocat");
    assert.deepEqual(
      calls.map((call) => call.url),
      ["https://api.github.com/user", "https://git.example.com/api/v3/user"],
    );
    assert.equal(calls[0].headers.Authorization, "Bearer tok");
    assert.equal(calls[0].headers["User-Agent"], "tet", "GitHub rejects a request without one");
  });

  it("refuses an answer without a login, and says what the API said for a refusal", async () => {
    serving(() => json({ login: "" }));
    await assert.rejects(github.validate("github.com", "tok"), /without a login/);
    serving(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, statusText: "Unauthorized" }));
    await assert.rejects(github.validate("github.com", "bad"), /Bad credentials \(401 Unauthorized\)/);
    serving(() => new Response("<html>proxy error</html>", { status: 502, statusText: "Bad Gateway" }));
    await assert.rejects(github.validate("github.com", "tok"), /^Error: 502 Bad Gateway$/);
  });

  it("lists the repositories as full name, name and clone url, most recently pushed first", async () => {
    const calls = serving(() => json([{ full_name: "o/r", name: "r", clone_url: "https://github.com/o/r.git", extra: 1 }]));
    assert.deepEqual(await github.listRepositories("github.com", "tok"), [
      { fullName: "o/r", name: "r", cloneUrl: "https://github.com/o/r.git" },
    ]);
    assert.equal(calls[0].url, "https://api.github.com/user/repos?per_page=100&sort=pushed");
  });
});

describe("GitLab", () => {
  it("asks the host's v4 API with the token as a private token", async () => {
    const calls = serving(() => json({ username: "tanuki" }));
    assert.equal(await gitlab.validate("gitlab.example.com", "tok"), "tanuki");
    assert.equal(calls[0].url, "https://gitlab.example.com/api/v4/user");
    assert.deepEqual(calls[0].headers, { "PRIVATE-TOKEN": "tok" });
    serving(() => json({}));
    await assert.rejects(gitlab.validate("gitlab.example.com", "tok"), /without a username/);
  });

  it("lists only the projects the user is a member of, in the short form", async () => {
    const calls = serving(() => json([{ path_with_namespace: "g/p", path: "p", http_url_to_repo: "https://gitlab.example.com/g/p.git" }]));
    assert.deepEqual(await gitlab.listRepositories("gitlab.example.com", "tok"), [
      { fullName: "g/p", name: "p", cloneUrl: "https://gitlab.example.com/g/p.git" },
    ]);
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("membership"), "true");
    assert.equal(url.searchParams.get("simple"), "true");
    assert.equal(url.searchParams.get("order_by"), "last_activity_at");
  });
});

describe("a listing in pages", () => {
  const repo = (n: number) => ({ full_name: `o/r${n}`, name: `r${n}`, clone_url: `u${n}` });

  it("fetches the rest at once when the Link header names the last page", async () => {
    const calls = serving((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json([repo(page)], page === 1 ? { link: '<https://api.github.com/user/repos?per_page=100&page=4>; rel="last"' } : {});
    });
    const names = (await github.listRepositories("github.com", "tok")).map((entry) => entry.name);
    assert.deepEqual(names, ["r1", "r2", "r3", "r4"]);
    assert.deepEqual(
      calls.slice(1).map((call) => new URL(call.url).searchParams.get("page")),
      ["2", "3", "4"],
    );
  });

  it("follows `next` one page at a time where no last page is named, and stops at the end", async () => {
    const calls = serving((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      const next: Record<string, string> = page < 3 ? { link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` } : {};
      return json([repo(page)], next);
    });
    assert.equal((await github.listRepositories("github.com", "tok")).length, 3);
    assert.equal(calls.length, 3);
  });

  it("stops at ten pages, however many an account reaches", async () => {
    const calls = serving((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json([repo(page)], {
        link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next", <https://api.github.com/x?page=999>; rel="foo"`,
      });
    });
    assert.equal((await github.listRepositories("github.com", "tok")).length, 10);
    assert.equal(calls.length, 10);
    const lastCalls = serving((url) =>
      json([repo(1)], url.searchParams.has("page") ? {} : { link: '<https://api.github.com/user/repos?page=500>; rel="last"' }),
    );
    assert.equal((await github.listRepositories("github.com", "tok")).length, 10);
    assert.equal(lastCalls.length, 10, "the first page and nine more");
  });

  it("counts a body that is no array as empty, and fails on a page that fails", async () => {
    serving(() => json({ message: "not a list" }));
    assert.deepEqual(await gitlab.listRepositories("gitlab.example.com", "tok"), []);
    serving((url) =>
      url.searchParams.get("page") === "2"
        ? new Response("{}", { status: 500, statusText: "Server Error" })
        : json([repo(1)], { link: '<https://api.github.com/user/repos?page=2>; rel="last"' }),
    );
    await assert.rejects(github.listRepositories("github.com", "tok"), /500 Server Error/);
  });
});

describe("the accounts kept for the providers", () => {
  const withStore = (): { root: string; store: AccountStore } => {
    fakeSafeStorage();
    const root = tempDir("tet-accounts-");
    return { root, store: new AccountStore(root) };
  };

  it("lists an account without its token, and gives the token back decrypted", () => {
    const { root, store } = withStore();
    const account = store.add("github", "github.com", "octocat", "secret-token");
    assert.equal("token" in store.list()[0], false);
    assert.equal(store.get(account.id)?.user, "octocat");
    assert.equal(store.token(account.id), "secret-token");
    assert.ok(!fs.readFileSync(path.join(root, "provider-accounts.json"), "utf8").includes("secret-token"), "kept sealed");
  });

  it("replaces the token of the same user on the same host, never adding a second row", () => {
    const { store } = withStore();
    const first = store.add("github", "github.com", "octocat", "old");
    const again = store.add("github", "github.com", "octocat", "new");
    store.add("gitlab", "github.com", "octocat", "other");
    assert.equal(again.id, first.id);
    assert.equal(store.list().length, 2);
    assert.equal(store.token(first.id), "new");
  });

  it("remembers the namespace of an account, and is a no-op for one that is gone", () => {
    const { store } = withStore();
    const { id } = store.add("gitlab", "gitlab.example.com", "tanuki", "t");
    store.setNamespace(id, "my-group");
    store.setNamespace("unknown", "x");
    assert.equal(store.get(id)?.namespace, "my-group");
    assert.equal(store.list().length, 1);
  });

  it("removes an account with its token, and a new store reads the file back", () => {
    const { root, store } = withStore();
    const keep = store.add("github", "github.com", "a", "ta");
    const drop = store.add("github", "github.com", "b", "tb");
    store.remove(drop.id);
    const reopened = new AccountStore(root);
    assert.deepEqual(
      reopened.list().map((account) => account.id),
      [keep.id],
    );
    assert.equal(reopened.token(keep.id), "ta");
    assert.equal(reopened.token(drop.id), undefined);
  });

  it("leaves out rows of a provider it does not know, and keeps nothing where the OS offers no encryption", () => {
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
    assert.throws(() => store.add("github", "github.com", "d", "t"));
    assert.equal(store.list().length, 1, "the row is not kept for a token that could not be sealed");
    assert.deepEqual(Object.keys(PROVIDERS).sort(), ["github", "gitlab"]);
  });
});
