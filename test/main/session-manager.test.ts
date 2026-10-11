import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { HOST_CALLER } from "../../src/main/ctl/caller-side";
import { SbxLocalStore } from "../../src/main/sbx/sbx-local";
import { SettingsStore } from "../../src/main/store/settings";
import { dropsDir } from "../../src/main/store/project-dirs";
import { HostSetups } from "../../src/main/terminals/host-setup";
import { type SessionManagerCallbacks, TabSessionManager } from "../../src/main/terminals/session-manager";
import type { TabDescriptor, TerminalStatus } from "../../src/shared/types/terminals";
import { eventually, tempDir } from "../helpers";

/** terminals/session-manager.ts: a tab's life from its creation to its close, through saved commands
 *  (a real process each, no agent needed). */

const STARTED_MS = 20_000;

// The ptys these tests start leave worker threads that keep node from exiting once the tests are done.
after(() => {
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});

interface Recording {
  tabs: TabDescriptor[];
  statuses: TerminalStatus[];
  output: string;
  notices: string[];
}

/** A manager on project "p" in a folder of its own, its callbacks recorded. */
async function withManager(use: (manager: TabSessionManager, recording: Recording, root: string) => Promise<void>): Promise<void> {
  const root = tempDir("tet-session-manager-");
  const settings = new SettingsStore(root);
  const recording: Recording = { tabs: [], statuses: [], output: "", notices: [] };
  const callbacks: SessionManagerCallbacks = {
    onTabs: (_ref, tabs) => {
      recording.tabs = tabs;
    },
    onOutput: (_ref, _tabId, data) => {
      recording.output += data;
    },
    onStatus: (_ref, _tabId, status) => {
      recording.statuses.push(status);
    },
    onStartupProgress: () => undefined,
    onNotice: (_severity, message) => recording.notices.push(message),
  };
  const manager = new TabSessionManager(
    { ref: { projectId: "p" }, path: root, name: () => "repo" },
    root,
    settings,
    new SbxLocalStore(root),
    new HostSetups(root, settings, () => undefined),
    callbacks,
  );
  try {
    await use(manager, recording, root);
  } finally {
    await manager.dispose();
  }
}

const status = (manager: TabSessionManager, tabId: string): TerminalStatus | undefined =>
  manager.snapshot().find((tab) => tab.tabId === tabId)?.status;

const waitForStatus = (manager: TabSessionManager, tabId: string, wanted: TerminalStatus): Promise<void> =>
  eventually(
    () => `${tabId} is ${status(manager, tabId)}, not ${wanted}`,
    () => status(manager, tabId) === wanted,
    STARTED_MS,
  );

const PRINTS = `node -e "console.log('marker-' + (6 * 7))"`;
const FAILS = `node -e "process.exit(3)"`;
const RUNS = `node -e "setInterval(() => {}, 1000)"`;
const ECHOES = `node -e "process.stdin.once('data', d => { console.log('got-' + d.toString().trim()); process.exit(0) })"`;

describe("a saved command's tab", () => {
  it("waits for its first fit, then runs the command and ends as the command did", async () => {
    await withManager(async (manager, recording) => {
      const passing = manager.createCommandTab({ command: PRINTS, name: "prints" });
      const failing = manager.createCommandTab({ command: FAILS });
      assert.equal(passing.title, "prints");
      assert.equal(failing.title, FAILS, "a command without a name is titled by its line");
      assert.equal(passing.savedCommand, true);
      assert.equal(passing.status, "ready");
      assert.equal(recording.output, "", "nothing runs before the first fit");

      assert.equal(manager.start(passing.tabId), true);
      manager.handleResize(failing.tabId, 100, 30);
      await waitForStatus(manager, passing.tabId, "stopped");
      await waitForStatus(manager, failing.tabId, "error");
      assert.match(recording.output, /marker-42/);
    });
  });

  it("types what it is written into the process and shows its answer", async () => {
    await withManager(async (manager, recording) => {
      const { tabId } = manager.createCommandTab({ command: ECHOES });
      manager.start(tabId);
      await waitForStatus(manager, tabId, "running");
      manager.write(tabId, "hello\r");
      await waitForStatus(manager, tabId, "stopped");
      assert.match(recording.output, /got-hello/);
    });
  });

  it("starts at the size of the fit, and a tab not fitted yet at the control channel's default", async () => {
    await withManager(async (manager, recording) => {
      const { tabId } = manager.createCommandTab({
        command: `node -e "console.log('size-' + process.stdout.columns + 'x' + process.stdout.rows)"`,
      });
      manager.handleResize(tabId, 91, 33);
      await waitForStatus(manager, tabId, "stopped");
      assert.match(recording.output, /size-91x33/);
    });
  });

  it("restarts a stopped one in place, and a running one only when the window asks", async () => {
    await withManager(async (manager, recording) => {
      const { tabId } = manager.createCommandTab({ command: RUNS });
      assert.equal(manager.restartTab(tabId), false, "no process yet");
      manager.start(tabId);
      await waitForStatus(manager, tabId, "running");
      assert.equal(manager.start(tabId), false, "a tab already started is not started again");
      assert.equal(manager.restartTab(tabId), false, "tabs-restart never ends a running process");
      assert.equal(manager.restartTab(tabId, true), true);
      await eventually("it runs again", () => recording.statuses.filter((entry) => entry === "running").length >= 2, STARTED_MS);
      assert.equal(manager.restartTab("missing"), false);
    });
  });

  it("is closed with its process, and says so in the events", async () => {
    await withManager(async (manager, recording) => {
      const { tabId } = manager.createCommandTab({ command: RUNS });
      manager.start(tabId);
      await waitForStatus(manager, tabId, "running");
      await manager.closeTabs([tabId, "unknown"]);
      assert.equal(manager.hasTab(tabId), false);
      assert.deepEqual(recording.tabs, []);
      assert.deepEqual(
        manager.events().map(({ tabId: id, kind }) => [id, kind]),
        [[tabId, "closed"]],
      );
      await manager.closeTabs([tabId]);
      assert.equal(manager.events().length, 1, "a tab closed twice is recorded once");
    });
  });

  it("runs in the folder given, relative to the repository or worktree", async () => {
    await withManager(async (manager, recording, root) => {
      const folder = path.join(root, "sub");
      fs.mkdirSync(folder);
      const { tabId } = manager.createCommandTab({
        command: `node -e "console.log('cwd-' + require('path').basename(process.cwd()))"`,
        cwd: "sub",
      });
      manager.start(tabId);
      await waitForStatus(manager, tabId, "stopped");
      assert.match(recording.output, /cwd-sub/);
    });
  });
});

describe("a tab's marks", () => {
  it("shows a finished turn until the tab is seen, and a seen one stays clear", async () => {
    await withManager(async (manager, recording) => {
      const { tabId } = manager.createTab("shell");
      const finishedAt = (): number | undefined => recording.tabs.find((tab) => tab.tabId === tabId)?.finishedAt;
      const at = Date.now();
      manager.hookEvent(tabId, "prompt-submit", "{}", at, HOST_CALLER);
      manager.hookEvent(tabId, "stop", "{}", at + 1000, HOST_CALLER);
      assert.notEqual(finishedAt(), undefined);
      manager.markSeen(tabId);
      assert.equal(finishedAt(), undefined);
      manager.markSeen(tabId);
      manager.markSeen("unknown");
      assert.equal(finishedAt(), undefined);
    });
  });

  it("is told apart by what a hook of a closed tab changes: nothing, but it is still answered", async () => {
    await withManager(async (manager, recording) => {
      const { tabId } = manager.createTab("shell");
      await manager.closeTabs([tabId]);
      const before = recording.tabs;
      assert.deepEqual(manager.hookEvent(tabId, "stop", "{}", Date.now(), HOST_CALLER), { stdout: "" });
      assert.equal(recording.tabs, before);
    });
  });
});

describe("a tab's paths and drops", () => {
  it("types a host tab's paths as they are, in the project's drops folder, and a closed tab's nothing", async () => {
    await withManager(async (manager, _recording, root) => {
      const { tabId } = manager.createTab("shell");
      assert.equal(manager.dropsDir(tabId), dropsDir(root, "p"));
      assert.deepEqual(await manager.seenPaths(tabId, ["/a/b"]), ["/a/b"]);
      assert.equal((await manager.handPaths(tabId, ["/a/b"])).length, 1);
      await manager.closeTabs([tabId]);
      assert.equal(manager.dropsDir(tabId), dropsDir(root, "p"), "a closed tab's content goes to the project's host folder");
      assert.deepEqual(await manager.seenPaths(tabId, ["/a/b"]), []);
      assert.deepEqual(await manager.handPaths(tabId, ["/a/b"]), []);
    });
  });
});

describe("a handover", () => {
  it("says why a tab cannot be handed over, instead of notifying it", async () => {
    await withManager(async (manager) => {
      assert.equal(await manager.handOver("unknown", "codex"), "The tab is closed");
      const { tabId } = manager.createTab("shell");
      const answer = await manager.handOver(tabId, "codex");
      assert.ok(typeof answer === "string");
      assert.match(answer, /has no session yet/);
    });
  });
});

describe("renaming a tab", () => {
  it("does nothing for a tab without a session, and for a closed one", async () => {
    await withManager(async (manager, recording) => {
      const { tabId } = manager.createTab("shell");
      assert.equal(await manager.renameTab(tabId, "New"), undefined);
      assert.equal(recording.tabs.find((tab) => tab.tabId === tabId)?.title, "", "the optimistic label reverts");
      assert.equal(await manager.renameTab("unknown", "New"), undefined);
    });
  });
});
