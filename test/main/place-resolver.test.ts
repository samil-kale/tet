import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { claudeAgent } from "../../src/main/agents/claude";
import { SbxLocalStore } from "../../src/main/sbx/sbx-local";
import type { ResolvedRef } from "../../src/main/store/resolved-ref";
import { SettingsStore } from "../../src/main/store/settings";
import { EMPTY_SBX_SETTINGS } from "../../src/shared/types/sbx";
import type { NoticeSeverity } from "../../src/shared/types/app";
import { PlaceResolver, type AgentPlaces, type PlaceReads } from "../../src/main/terminals/place-resolver";
import { CommandPlace, HostPlace, SandboxPlace, type PlaceContext } from "../../src/main/terminals/tab-place";
import type { TabState } from "../../src/main/terminals/tab-state";
import { tempDir } from "../helpers";

/** terminals/place-resolver.ts: where a start runs a tab, and what it says where it runs it nowhere. */

const AT: ResolvedRef = { ref: { projectId: "p" }, path: path.join("projects", "repo"), name: () => "repo" };

/** What sbx and tet.json answer, recording the sandboxes started ahead of the check. */
function sbxAnswering(enabled: boolean, notReady?: string): { reads: PlaceReads; warmed: string[] } {
  const warmed: string[] = [];
  const reads: PlaceReads = {
    readSbxSettings: () => Promise.resolve({ ...EMPTY_SBX_SETTINGS, enabled }),
    checkSbxReady: () => Promise.resolve(notReady === undefined ? { sandboxes: new Map() } : { notReady }),
    sbxListed: () => Promise.resolve(),
    ensureRunning: (name) => {
      warmed.push(name);
      return Promise.resolve(true);
    },
  };
  return { reads, warmed };
}

/** A resolver for the repository with an agent that has a sandbox, its notices collected. */
function resolver(reads: PlaceReads, { sbxOnly = false, sandboxed = true } = {}) {
  const root = tempDir("tet-place-resolver-");
  const notices: { severity: NoticeSeverity; message: string }[] = [];
  const onNotice = (severity: NoticeSeverity, message: string): void => {
    notices.push({ severity, message });
  };
  const context: PlaceContext<typeof claudeAgent> = { at: AT, dataRoot: root, agent: claudeAgent, executable: "claude-bin", onNotice };
  const places: AgentPlaces = {
    agent: claudeAgent,
    executable: "claude-bin",
    sbxOnly,
    host: new HostPlace(context, () => undefined),
    ...(sandboxed && { sandbox: new SandboxPlace(context) }),
  };
  const resolving = new PlaceResolver(
    AT,
    new SettingsStore(root),
    new SbxLocalStore(root),
    { placeContext: () => context, onNotice },
    reads,
  );
  return { resolving, places, notices };
}

function tab(extra: Partial<TabState> = {}): TabState {
  return { tabId: "t1", agentId: claudeAgent.id, title: "", status: "ready", ...extra };
}

describe("where a start runs a tab", () => {
  it("runs a saved command on this machine as it is, whatever SBX says", async () => {
    const { resolving, places } = resolver(sbxAnswering(true, "not signed in").reads);
    const place = await resolving.resolvePlace(tab({ agentId: "shell", runArgs: ["-c", "make"] }), places);
    assert.ok(place instanceof CommandPlace);
  });

  it("runs an agent without a sandbox on this machine, never asking sbx", async () => {
    const { reads } = sbxAnswering(true, "not signed in");
    let asked = false;
    const { resolving, places } = resolver(
      {
        ...reads,
        readSbxSettings: () => {
          asked = true;
          return Promise.resolve(EMPTY_SBX_SETTINGS);
        },
      },
      { sandboxed: false },
    );
    assert.equal(await resolving.resolvePlace(tab(), places), places.host);
    assert.equal(asked, false);
  });

  describe("with SBX disabled for the project", () => {
    it("runs a tab on this machine, silently", async () => {
      const { resolving, places, notices } = resolver(sbxAnswering(false).reads);
      assert.equal(await resolving.resolvePlace(tab(), places), places.host);
      assert.equal(await resolving.resolvePlace(tab({ sessionId: "s1" }), places), places.host);
      assert.deepEqual(notices, []);
    });

    it("runs nowhere a tab that cannot run on this machine, saying why", async () => {
      const cases: [string, Partial<TabState>, boolean, RegExp][] = [
        ["a session in the sandbox", { sessionId: "s1", sandbox: "claude-p" }, false, /session lives in repo's SBX sandbox/],
        ["a tab opened from the sandbox", { sandboxOnly: true }, false, /opened from repo's SBX sandbox/],
        ["an sbx-only agent", {}, true, /not installed on this machine and only runs in repo's SBX sandbox/],
      ];
      for (const [what, extra, sbxOnly, said] of cases) {
        const { resolving, places, notices } = resolver(sbxAnswering(false).reads, { sbxOnly });
        assert.equal(await resolving.resolvePlace(tab(extra), places), "stranded", what);
        assert.equal(notices.length, 1, what);
        assert.equal(notices[0].severity, "warning");
        assert.match(notices[0].message, said, what);
        assert.match(notices[0].message, /SBX is disabled for the project\. The tab menu's Restart tries again/, what);
      }
    });
  });

  describe("with SBX enabled but not ready", () => {
    it("runs a tab nowhere rather than on this machine, in one notice", async () => {
      const { resolving, places, notices } = resolver(sbxAnswering(true, "sbx is not signed in").reads);
      assert.equal(await resolving.resolvePlace(tab(), places), "stranded");
      assert.deepEqual(
        notices.map(({ severity }) => severity),
        ["warning"],
      );
      assert.match(notices[0].message, /SBX is not available for repo: sbx is not signed in\. The tab does not start on this machine/);
    });

    it("says only that a session in the sandbox cannot run here", async () => {
      const { resolving, places, notices } = resolver(sbxAnswering(true, "sbx is not signed in").reads);
      assert.equal(await resolving.resolvePlace(tab({ sessionId: "s1", sandbox: "claude-p" }), places), "stranded");
      assert.equal(notices.length, 1);
      assert.match(notices[0].message, /session lives in repo's SBX sandbox and cannot run on this machine: sbx is not signed in/);
    });
  });

  describe("with SBX ready", () => {
    it("runs a new tab in the sandbox, its start begun ahead of the check", async () => {
      const { reads, warmed } = sbxAnswering(true);
      const { resolving, places, notices } = resolver(reads);
      const place = await resolving.resolvePlace(tab(), places);
      assert.notEqual(place, "stranded");
      assert.equal(place === "stranded" ? undefined : place.sandbox, places.sandbox?.name);
      assert.deepEqual(warmed, [places.sandbox?.name]);
      assert.deepEqual(notices, []);
    });

    it("keeps a session made on this machine there, said once per repository or worktree", async () => {
      const { reads, warmed } = sbxAnswering(true);
      const { resolving, places, notices } = resolver(reads);
      assert.equal(await resolving.resolvePlace(tab({ sessionId: "s1" }), places), places.host);
      assert.equal(await resolving.resolvePlace(tab({ tabId: "t2", sessionId: "s2" }), places), places.host);
      assert.deepEqual(
        notices.map(({ severity }) => severity),
        ["info"],
      );
      assert.match(notices[0].message, /started while SBX was disabled for repo keep running on this machine/);
      assert.deepEqual(warmed, [], "no sandbox started for a tab on this machine");
    });

    it("runs nowhere a session made on this machine whose tab may only run in the sandbox", async () => {
      const { resolving, places, notices } = resolver(sbxAnswering(true).reads);
      assert.equal(await resolving.resolvePlace(tab({ sessionId: "s1", sandboxOnly: true }), places), "stranded");
      assert.equal(notices.length, 1);
      assert.match(
        notices[0].message,
        /opened from repo's SBX sandbox and cannot run on this machine: its session was found on this machine/,
      );
    });

    it("runs nowhere a session made on this machine of an agent no longer installed here, offering no retry", async () => {
      const { resolving, places, notices } = resolver(sbxAnswering(true).reads, { sbxOnly: true });
      assert.equal(await resolving.resolvePlace(tab({ sessionId: "s1" }), places), "stranded");
      assert.equal(notices.length, 1);
      assert.match(notices[0].message, /is not installed on this machine any more/);
      assert.doesNotMatch(notices[0].message, /Restart tries again/);
    });
  });
});
