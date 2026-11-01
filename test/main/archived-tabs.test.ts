import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { SessionProvider } from "../../src/main/agents/agent";
import { claudeAgent } from "../../src/main/agents/claude";
import { archivedIds } from "../../src/main/store/archive";
import { archiveFile } from "../../src/main/store/project-dirs";
import { ArchivedTabs } from "../../src/main/terminals/archived-tabs";
import { HostPlace } from "../../src/main/terminals/tab-place";
import { toDescriptor, type TabState } from "../../src/main/terminals/tab-state";
import type { ActionResult } from "../../src/shared/types/action";
import type { TabDescriptor } from "../../src/shared/types/terminals";
import { deferred, tempDir } from "../helpers";

/** terminals/archived-tabs.ts: the tabs kept archived, archive.json naming them, their sessions the
 *  agent's own. */

const REF = { projectId: "p" };

/** What a result refused, in its words; undefined where it was done. */
function refused(result: ActionResult): string | undefined {
  return result.ok ? undefined : result.error;
}

/** Whether `promise` has settled by the time pending callbacks ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

/**
 * Archived tabs of the repository on a fresh data folder, over a session store recording its calls
 * ("<operation>:<id>"): `files` answers what `filesOf` says, `remove` and `rename` throw `refusal`.
 */
function archive(options: { filesOf?: (id: string) => string[]; refusal?: string } = {}) {
  const dataRoot = tempDir("tet-archived-");
  const calls: string[] = [];
  const deletingSessionIds = new Set<string>();
  const fail = (): Promise<void> => (options.refusal === undefined ? Promise.resolve() : Promise.reject(new Error(options.refusal)));
  const sessions: SessionProvider = {
    list: () => Promise.resolve([]),
    resumeArgs: (id) => ["--resume", id],
    remove: (_executable, _cwd, id) => {
      calls.push(`remove:${id}${deletingSessionIds.has(id) ? " (deleting)" : ""}`);
      return fail();
    },
    rename: (_executable, _cwd, id, title) => {
      calls.push(`rename:${id}:${title}`);
      return fail();
    },
    files: (_cwd, id) => {
      calls.push(`files:${id}`);
      return Promise.resolve(options.filesOf?.(id) ?? [`${id}.jsonl`]);
    },
  };
  const agent = { ...claudeAgent, sessions };
  const place = new HostPlace(
    {
      at: { ref: REF, path: path.join(dataRoot, "repo"), name: () => "repo" },
      dataRoot,
      agent,
      executable: "claude-bin",
      onNotice: () => undefined,
    },
    () => undefined,
  );
  const strip: TabState[] = [];
  const posted: TabDescriptor[][] = [];
  /** What the next tab taken off the strip stops on; none: it has no process. */
  let stopping: Promise<void> | undefined;
  const archived = new ArchivedTabs(dataRoot, REF, {
    agentOf: () => agent,
    placeOf: () => place,
    descriptorOf: (tab) => toDescriptor(tab, false, false),
    deletingSessionIds,
    takeOffStrip: (tab) => {
      calls.push(`off-strip:${tab.tabId}`);
      strip.splice(strip.indexOf(tab), 1);
      return stopping;
    },
    reopened: (tab) => {
      calls.push(`reopened:${tab.tabId}`);
      strip.push(tab);
    },
    onChanged: (tabs) => posted.push(tabs),
    removeHandoverCopy: (dir) => calls.push(`handover-copy:${dir}`),
  });
  return {
    archived,
    dataRoot,
    calls,
    posted,
    strip,
    stopWith: (promise: Promise<void> | undefined) => {
      stopping = promise;
    },
  };
}

/** A running tab on the strip, in a turn and asking, with session `s1`. */
function running(strip: TabState[], extra: Partial<TabState> = {}): TabState {
  const tab: TabState = {
    tabId: "t1",
    agentId: claudeAgent.id,
    title: "first",
    status: "running",
    sessionId: "s1",
    inTurn: true,
    waitingAt: 5,
    ...extra,
  };
  strip.push(tab);
  return tab;
}

describe("keeping a tab archived", () => {
  it("writes its session down, takes it off the strip with its marks cleared, and lists it", () => {
    const { archived, dataRoot, calls, posted, strip } = archive();
    const tab = running(strip);
    assert.equal(refused(archived.keep(tab, "s1")), undefined);
    assert.deepEqual(archivedIds(dataRoot, REF), ["s1"]);
    assert.deepEqual(strip, []);
    assert.deepEqual(calls, ["off-strip:t1"]);
    assert.equal(tab.status, "ready");
    assert.equal(tab.inTurn, false);
    assert.equal(tab.waitingAt, undefined);
    assert.deepEqual(
      posted.at(-1)?.map((descriptor) => descriptor.tabId),
      ["t1"],
    );
  });

  it("refuses a tab that moved on to a session no listing has shown yet, leaving it on the strip", () => {
    const { archived, dataRoot, calls, posted, strip } = archive();
    const tab = running(strip, { reportedSessionId: "s2" });
    assert.match(refused(archived.keep(tab, "s1")) ?? "", /session is not listed yet/);
    assert.deepEqual(strip, [tab]);
    assert.deepEqual(archivedIds(dataRoot, REF), []);
    assert.deepEqual(calls, []);
    assert.deepEqual(posted, []);
  });

  it("leaves the tab as it is when archive.json cannot be written", () => {
    const { archived, dataRoot, calls, posted, strip } = archive();
    // A folder where the file goes: every write of it fails.
    fs.mkdirSync(archiveFile(dataRoot, REF.projectId), { recursive: true });
    const tab = running(strip);
    assert.match(refused(archived.keep(tab, "s1")) ?? "", new RegExp(`^Could not keep the ${claudeAgent.displayName} session: `));
    assert.deepEqual(strip, [tab]);
    assert.equal(tab.status, "running");
    assert.equal(tab.inTurn, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(posted, []);
    assert.deepEqual(archived.all(), []);
  });

  it("lists the archived tabs in archive.json's order, newest first, as a drag reorders them", () => {
    const { archived, dataRoot, strip } = archive();
    archived.keep(running(strip), "s1");
    archived.keep(running(strip, { tabId: "t2", sessionId: "s2" }), "s2");
    assert.deepEqual(
      archived.snapshot().map((tab) => tab.tabId),
      ["t2", "t1"],
    );
    assert.equal(refused(archived.reorder(["t1", "t2"])), undefined);
    assert.deepEqual(archivedIds(dataRoot, REF), ["s1", "s2"]);
    assert.deepEqual(
      archived.snapshot().map((tab) => tab.tabId),
      ["t1", "t2"],
    );
  });
});

describe("an archived tab", () => {
  it("is reopened only once its process has stopped, back at the end of the strip", async () => {
    const { archived, dataRoot, calls, strip, stopWith } = archive();
    const stop = deferred();
    stopWith(stop.promise);
    archived.keep(running(strip), "s1");
    const reopening = archived.reopen("t1");
    assert.equal(await settled(reopening), false, "waits for the stop");
    assert.ok(!calls.includes("files:s1"));
    stop.resolve();
    assert.equal(refused(await reopening), undefined);
    assert.deepEqual(
      strip.map((tab) => tab.tabId),
      ["t1"],
    );
    assert.deepEqual(archived.all(), []);
    assert.deepEqual(archivedIds(dataRoot, REF), []);
    assert.deepEqual(calls.slice(-2), ["files:s1", "reopened:t1"]);
  });

  it("whose session was deleted outside TET is dropped when reopened, said rather than put back", async () => {
    const { archived, dataRoot, calls, strip } = archive({ filesOf: () => [] });
    archived.keep(running(strip), "s1");
    assert.match(refused(await archived.reopen("t1")) ?? "", /session was deleted outside TET/);
    assert.deepEqual(strip, []);
    assert.deepEqual(archived.all(), []);
    assert.deepEqual(archivedIds(dataRoot, REF), []);
    assert.ok(!calls.includes("reopened:t1"));
  });

  it("is renamed through its agent, and keeps its name where the agent refuses", async () => {
    const renaming = archive();
    const tab = running(renaming.strip, { provisionalTitle: true });
    renaming.archived.keep(tab, "s1");
    assert.equal(refused(await renaming.archived.rename("t1", "  named ")), undefined);
    assert.equal(tab.title, "named");
    assert.equal(tab.provisionalTitle, false);

    const refusing = archive({ refusal: "read-only" });
    const kept = running(refusing.strip);
    refusing.archived.keep(kept, "s1");
    assert.equal(refused(await refusing.archived.rename("t1", "named")), `Could not rename ${claudeAgent.displayName} session: read-only`);
    assert.equal(kept.title, "first");
  });

  it("is deleted once its process has stopped, its session removed while held from reconcile, its copy with it", async () => {
    const { archived, dataRoot, calls, posted, strip, stopWith } = archive();
    const stop = deferred();
    stopWith(stop.promise);
    archived.keep(running(strip, { handoverDir: "copy" }), "s1");
    const deleting = archived.delete("t1");
    assert.equal(await settled(deleting), false, "waits for the stop");
    stop.resolve();
    assert.equal(refused(await deleting), undefined);
    assert.deepEqual(calls.slice(-2), ["remove:s1 (deleting)", "handover-copy:copy"]);
    assert.deepEqual(archived.all(), []);
    assert.deepEqual(archivedIds(dataRoot, REF), []);
    assert.deepEqual(posted.at(-1), []);
  });

  it("stays archived where its agent refuses to delete the session", async () => {
    const { archived, dataRoot, strip } = archive({ refusal: "busy" });
    archived.keep(running(strip), "s1");
    assert.equal(refused(await archived.delete("t1")), `Could not delete the ${claudeAgent.displayName} session: busy`);
    assert.deepEqual(
      archived.all().map((tab) => tab.tabId),
      ["t1"],
    );
    assert.deepEqual(archivedIds(dataRoot, REF), ["s1"]);
  });

  it("answers nothing for a tab it does not hold", async () => {
    const { archived } = archive();
    assert.equal(refused(await archived.reopen("t9")), undefined);
    assert.equal(refused(await archived.rename("t9", "x")), undefined);
    assert.equal(refused(await archived.delete("t9")), undefined);
  });
});
