import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AccountStore } from "../../src/main/providers/accounts";
import { PROVIDERS } from "../../src/main/providers";
import { RepoCache } from "../../src/main/providers/repo-cache";
import { fakeSafeStorage, tempDir } from "../helpers";

/** providers/: the accounts kept for the providers. */

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
