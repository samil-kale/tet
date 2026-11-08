import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { changeIssueSource, issueRepository, unreadIssues, type IssueDeps } from "../../src/main/issues";
import { PROVIDERS } from "../../src/main/providers";
import type { IssueRepository } from "../../src/main/providers/issues";
import type { Tracker } from "../../src/main/providers/provider";
import { issuesSeenFile } from "../../src/main/store/project-dirs";
import { PROJECT_NOT_FOUND } from "../../src/main/store/resolved-ref";
import type { ProviderAccount } from "../../src/shared/types/providers";
import { tempDir } from "../helpers";

type Deps = Pick<IssueDeps, "accounts" | "dataRoot" | "repositories">;

const ACCOUNT: ProviderAccount = { id: "a", provider: "github", host: "github.com", user: "a" };

/** The project "p1", whose repository lies in `root` with a remote on github.com; `accounts` hold
 *  the host's account. */
function depsAt(dataRoot: string, root: string, accounts: ProviderAccount[] = [ACCOUNT]): Deps {
  const repository: IssueRepository = {
    at: { path: root },
    started: () => Promise.resolve(),
    getState: () => ({ remotes: [{ name: "origin", branches: [], mergedBranches: [], url: "git@github.com:o/r.git" }] }),
  };
  return {
    accounts: { list: () => accounts, token: async (id) => `token-${id}` },
    dataRoot,
    repositories: { get: (ref) => (ref.projectId === "p1" ? repository : undefined) },
  };
}

/** What the project's issue tabs showed: the file `readIssuesSeen` reads. */
function keepSeen(dataRoot: string, seen: object): void {
  const file = issuesSeenFile(dataRoot, "p1");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(seen));
}

describe("the issues of a project", () => {
  it("are read through its repository, which has to be open", () => {
    const deps = depsAt(tempDir("tet-issues-data-"), tempDir("tet-issues-"));
    assert.equal(issueRepository(deps, "p1").at.path, deps.repositories.get({ projectId: "p1" })?.at.path);
    assert.throws(() => issueRepository(deps, "p2"), new RegExp(PROJECT_NOT_FOUND));
  });

  it("are unread once the tracker changed an open one after its tab showed it", async (t) => {
    const asked: unknown[] = [];
    t.mock.method(PROVIDERS.github, "listIssues", async (_tracker: Tracker, filter: unknown) => {
      asked.push(filter);
      return [
        { number: 1, updatedAt: "2026-11-02T00:00:00Z" },
        { number: 2, updatedAt: "2026-11-02T00:00:00Z" },
        { number: 3, updatedAt: "2026-10-01T00:00:00Z" },
      ];
    });
    const dataRoot = tempDir("tet-issues-data-");
    keepSeen(dataRoot, { since: "2026-11-01T00:00:00Z", issues: { 2: "2026-11-02T00:00:00Z" } });
    const unread = await unreadIssues(depsAt(dataRoot, tempDir("tet-issues-")), "p1");
    assert.deepEqual(
      unread.map((issue) => issue.number),
      [1],
      "2 was shown as it is, 3 is older than `since`",
    );
    assert.deepEqual(asked, [{ state: "open", labels: [] }]);
  });

  it("start no count of unread ones while the tracker cannot be reached", async () => {
    const dataRoot = tempDir("tet-issues-data-");
    await assert.rejects(() => unreadIssues(depsAt(dataRoot, tempDir("tet-issues-"), []), "p1"), /No account for github\.com/);
    assert.equal(fs.existsSync(issuesSeenFile(dataRoot, "p1")), false);
  });

  it("forget what their tabs showed once their source changed, and not before", async (t) => {
    t.mock.method(PROVIDERS.github, "listLabels", async () => []);
    const dataRoot = tempDir("tet-issues-data-");
    const root = tempDir("tet-issues-");
    const deps = depsAt(dataRoot, root);
    const seen = { since: "2026-11-01T00:00:00Z", issues: { 2: "2026-11-02T00:00:00Z" } };

    keepSeen(dataRoot, seen);
    assert.equal(await changeIssueSource(deps, "p1", "g/tracker"), "g/tracker");
    assert.equal(fs.existsSync(issuesSeenFile(dataRoot, "p1")), false, "another tracker's numbers");

    keepSeen(dataRoot, seen);
    assert.equal(await changeIssueSource(deps, "p1", "g/tracker"), "g/tracker");
    assert.deepEqual(JSON.parse(fs.readFileSync(issuesSeenFile(dataRoot, "p1"), "utf8")), seen, "the same one");

    assert.equal(await changeIssueSource(deps, "p1", ""), undefined);
    assert.equal(fs.existsSync(issuesSeenFile(dataRoot, "p1")), false, "back to the repository's own");
  });
});
