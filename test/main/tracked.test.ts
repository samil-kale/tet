import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TrackedOps } from "../../src/main/ctl/ctl-verb";
import type { TrackedDeps } from "../../src/main/issues";
import { PROJECT_NOT_FOUND } from "../../src/main/store/resolved-ref";
import { sendTrackedToAgent, trackedSessions } from "../../src/main/tracked";
import type { AgentId } from "../../src/shared/types/agents";
import { projectRef, type Project, type ProjectRef } from "../../src/shared/types/project";
import type { TrackedKind, TrackedRef } from "../../src/shared/types/providers";
import type { TabDescriptor } from "../../src/shared/types/terminals";

/** tracked.ts with the store and the tab managers faked: which session each issue or change request
 *  has, read off the tabs, and a tab sent one as its first prompt. */

type Deps = Pick<TrackedDeps, "store" | "tabManagers">;

const PROJECT: Project = {
  id: "p1",
  path: "/repo",
  name: "repo",
  worktrees: [{ path: "/worktrees/k1", branch: "topic", key: "k1" }],
};

/** A tab of `agentId` linked to what `linked` names. */
function tab(tabId: string, linked?: TabDescriptor["linked"]): TabDescriptor {
  return { tabId, agentId: "claude", title: `title of ${tabId}`, status: "running", ...(linked && { linked }) };
}

/** What a fake manager of one repository or worktree records of the tabs made in it. */
interface Made {
  ref: ProjectRef;
  agentId: AgentId;
  file: { name: string; content: string; prompt?: string };
  sandboxOnly: boolean;
}

/** A tab manager per ref: its tabs on the strip and archived. */
function depsWith(managers: { ref: ProjectRef; tabs?: TabDescriptor[]; archived?: TabDescriptor[] }[]): {
  deps: Deps;
  made: Made[];
  links: { tabId: string; tracked: TrackedRef }[];
} {
  const made: Made[] = [];
  const links: { tabId: string; tracked: TrackedRef }[] = [];
  const fakes = managers.map(({ ref, tabs = [], archived = [] }) => ({
    at: { ref },
    snapshot: () => tabs,
    archivedSnapshot: () => archived,
    createTabOnFile: (agentId: AgentId, file: Made["file"], sandboxOnly: boolean) => {
      made.push({ ref, agentId, file, sandboxOnly });
      return tab(`new-${made.length}`);
    },
    link: (tabId: string, tracked: TrackedRef) => {
      links.push({ tabId, tracked });
      return { ok: true };
    },
  }));
  const tabManagers = {
    forProject: (projectId: string) => fakes.filter((fake) => fake.at.ref.projectId === projectId),
    get: (ref: ProjectRef) => fakes.find((fake) => fake.at.ref.projectId === ref.projectId && fake.at.ref.worktree === ref.worktree),
  } as unknown as Deps["tabManagers"];
  const store = { get: (id: string) => (id === PROJECT.id ? PROJECT : undefined) } as unknown as Deps["store"];
  return { deps: { store, tabManagers }, made, links };
}

/** Ops whose `agentFile` answers a text and a prompt naming the number, or throws `refusal`. */
function opsWith(refusal?: string): Record<TrackedKind, TrackedOps> {
  const opsOf = (kind: TrackedKind): TrackedOps =>
    ({
      nameOf: (number: number) => `${kind} ${number}`,
      agentFile: async (_ref: ProjectRef, number: number) => {
        if (refusal !== undefined) {
          throw new Error(refusal);
        }
        return { content: `text of ${number}`, prompt: `prompt of ${number}` };
      },
    }) as unknown as TrackedOps;
  return { issue: opsOf("issue"), "change-request": opsOf("change-request") };
}

describe("the sessions of a project's issues and change requests", () => {
  it("are read off the linked tabs of the repository and its worktrees, on the strip or archived", () => {
    const { deps } = depsWith([
      { ref: projectRef("p1"), tabs: [tab("a", { issue: 3 }), tab("b")], archived: [tab("c", { issue: 4, "change-request": 7 })] },
      { ref: projectRef("p1", "k1"), tabs: [tab("d", { "change-request": 8 })] },
      { ref: projectRef("p2"), tabs: [tab("e", { issue: 5 })] },
    ]);
    assert.deepEqual(trackedSessions(deps, "p1", "issue"), {
      3: { ref: projectRef("p1"), tabId: "a", agentId: "claude", title: "title of a", archived: false },
      4: { ref: projectRef("p1"), tabId: "c", agentId: "claude", title: "title of c", archived: true },
    });
    assert.deepEqual(trackedSessions(deps, "p1", "change-request"), {
      7: { ref: projectRef("p1"), tabId: "c", agentId: "claude", title: "title of c", archived: true },
      8: { ref: projectRef("p1", "k1"), worktree: "topic", tabId: "d", agentId: "claude", title: "title of d", archived: false },
    });
  });

  it("are refused for a project TET does not have", () => {
    const { deps } = depsWith([]);
    assert.throws(() => trackedSessions(deps, "p9", "issue"), new RegExp(PROJECT_NOT_FOUND));
  });
});

describe("an issue or change request sent to an agent", () => {
  it("opens a tab of the agent on its text, its prompt the first, and links the tab to it", async () => {
    const { deps, made, links } = depsWith([{ ref: projectRef("p1") }, { ref: projectRef("p1", "k1") }]);
    const sent = await sendTrackedToAgent(deps, opsWith(), projectRef("p1", "k1"), { kind: "change-request", number: 7 }, "codex", true);
    assert.equal(sent.ok, true);
    assert.deepEqual(made, [
      {
        ref: projectRef("p1", "k1"),
        agentId: "codex",
        file: { name: "change-request-7.md", content: "text of 7", prompt: "prompt of 7" },
        sandboxOnly: true,
      },
    ]);
    assert.deepEqual(links, [{ tabId: "new-1", tracked: { kind: "change-request", number: 7 } }]);
  });

  it("is refused for one that has a session already", async () => {
    const { deps, made } = depsWith([{ ref: projectRef("p1"), archived: [tab("a", { issue: 3 })] }]);
    const sent = await sendTrackedToAgent(deps, opsWith(), projectRef("p1"), { kind: "issue", number: 3 }, "claude");
    assert.deepEqual(sent, { ok: false, error: "Issue 3 has a session already" });
    assert.deepEqual(made, []);
  });

  it("is refused where the repository or worktree is not open", async () => {
    const { deps } = depsWith([{ ref: projectRef("p1") }]);
    const sent = await sendTrackedToAgent(deps, opsWith(), projectRef("p1", "k1"), { kind: "issue", number: 3 }, "claude");
    assert.deepEqual(sent, { ok: false, error: "topic (repo) is not open" });
  });

  it("answers what the host refused, and opens nothing", async () => {
    const { deps, made, links } = depsWith([{ ref: projectRef("p1") }]);
    const sent = await sendTrackedToAgent(deps, opsWith("Not found"), projectRef("p1"), { kind: "issue", number: 3 }, "claude");
    assert.deepEqual(sent, { ok: false, error: "Not found" });
    assert.deepEqual(made, []);
    assert.deepEqual(links, []);
  });
});
