import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it, mock } from "node:test";
import type { IPty } from "node-pty";
import type { SessionProvider } from "../../src/main/agents/agent";
import { claudeAgent } from "../../src/main/agents/claude";
import { HOST_CALLER } from "../../src/main/ctl/caller-side";
import type { TabSessionManager } from "../../src/main/terminals/session-manager";
import { HostPlace } from "../../src/main/terminals/tab-place";
import type { TabState } from "../../src/main/terminals/tab-state";
import { PLATFORM } from "../../src/main/util/host-platform";
import type { TabDescriptor } from "../../src/shared/types/terminals";
import { deferred, eventually, sleep } from "../helpers";
import { withEmptyPath } from "../helpers/session-manager";

/** terminals/session-manager.ts: a tab's process from its start to its end, and what happens when
 *  the window acts while one of them is underway. Over a pty and a session store standing in, so any
 *  race is held open on purpose. */

/** Long enough for what a start still has underway to have spawned, were it going to. */
const SETTLE_MS = 100;
/** Past TerminalSession's whole stop, which a process that outlives it is waited out for. */
const OUTLIVED_STOP_MS = 5000;

/** A process that leaves when asked to quit or killed, or with `hang` only when the test says so. */
class FakeProcess {
  exited = false;
  private readonly exitListeners: ((exit: { exitCode: number }) => void)[] = [];

  constructor(private readonly hang: boolean) {}

  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  onExit(listener: (exit: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => undefined };
  }

  resize(): void {
    return undefined;
  }

  write(data: string): void {
    if (data === "\x03") {
      this.leaveUnlessHanging();
    }
  }

  kill(): void {
    this.leaveUnlessHanging();
  }

  exit(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode: 0 });
    }
  }

  private leaveUnlessHanging(): void {
    if (!this.hang) {
      setTimeout(() => this.exit(), 5);
    }
  }
}

/** What a test holds over its manager. */
interface Lifecycle {
  manager: TabSessionManager;
  /** Every process spawned, oldest first. */
  processes: FakeProcess[];
  /** What happened to sessions and terminals, in order. */
  log: string[];
  notices: string[];
  /** The next process ignores being asked to quit and killed. */
  hangNext: () => void;
  /** Session deletes throw until set back. */
  failRemoves: (fails: boolean) => void;
  /** A tab holding session `s1`, not started. */
  sessionTab: () => string;
  /** A tab holding session `s1`, its process running. */
  runningTab: () => Promise<string>;
  /** A tab holding session `s1`, fitted, its start held until `open`. */
  heldTab: () => Promise<{ tabId: string; open: () => void }>;
  /** Waits for the `count`th process. */
  spawned: (count: number, ms?: number) => Promise<void>;
  tab: (tabId: string) => TabDescriptor | undefined;
  /** How many processes have not exited. */
  live: () => number;
}

/** Runs `use` over a Claude Code tab's manager: its real definition for its sessions and hooks, none
 *  of it running (PATH is empty). */
async function withLifecycle(use: (lifecycle: Lifecycle) => Promise<void>): Promise<void> {
  const processes: FakeProcess[] = [];
  const log: string[] = [];
  const notices: string[] = [];
  let hanging = false;
  let launchGate: Promise<void> | undefined;
  let removesFail = false;
  const sessions: SessionProvider = {
    list: () => Promise.resolve([]),
    resumeArgs: (id) => ["--resume", id],
    remove: async (_executable, _cwd, id) => {
      log.push(`removed ${id}`);
      if (removesFail) {
        throw new Error("locked");
      }
    },
    rename: () => Promise.resolve(),
    files: () => Promise.resolve(["session.jsonl"]),
  };

  await withEmptyPath(
    { onNotice: (_severity, message) => notices.push(message) },
    async (manager, project) => {
      const internals = manager as unknown as {
        tabs: TabState[];
        runtimeFor(agentId: string): { ready: Promise<void>; startable: boolean; sandbox?: unknown; host: HostPlace };
      };
      const runtime = internals.runtimeFor("claude");
      await runtime.ready;
      runtime.startable = true;
      runtime.sandbox = undefined;
      runtime.host = new HostPlace(
        {
          at: manager.at,
          dataRoot: path.dirname(project),
          agent: { ...claudeAgent, sessions },
          executable: "agent",
          onNotice: () => undefined,
        },
        () => undefined,
      );
      mock.method(runtime.host, "launch", async () => {
        await launchGate;
        return { executable: "agent", args: [] };
      });
      const terminals = mock.method(PLATFORM, "externalTerminals", () => {
        log.push("terminal opened");
        return [{ command: process.execPath, args: ["-e", ""] }];
      });

      const tab = (tabId: string): TabDescriptor | undefined => manager.snapshot().find((candidate) => candidate.tabId === tabId);
      const sessionTab = (): string => {
        const { tabId } = manager.createTab("claude");
        Object.assign(internals.tabs.find((candidate) => candidate.tabId === tabId) ?? {}, { sessionId: "s1", reportedSessionId: "s1" });
        return tabId;
      };
      try {
        await use({
          manager,
          processes,
          log,
          notices,
          hangNext: () => {
            hanging = true;
          },
          failRemoves: (fails) => {
            removesFail = fails;
          },
          sessionTab,
          runningTab: async () => {
            const tabId = sessionTab();
            manager.handleResize(tabId, 80, 24);
            await eventually("the tab runs", () => tab(tabId)?.status === "running");
            return tabId;
          },
          heldTab: async () => {
            const gate = deferred();
            launchGate = gate.promise;
            const tabId = sessionTab();
            manager.handleResize(tabId, 80, 24);
            await sleep(SETTLE_MS);
            return { tabId, open: gate.resolve };
          },
          spawned: (count, ms) => eventually(`process ${count}`, () => processes.length === count, ms),
          tab,
          live: () => processes.filter((candidate) => !candidate.exited).length,
        });
      } finally {
        terminals.mock.restore();
        for (const process of processes) {
          process.exit();
        }
      }
    },
    () => {
      const process = new FakeProcess(hanging);
      hanging = false;
      processes.push(process);
      return process as unknown as IPty;
    },
  );
}

describe("a restart clicked twice", () => {
  it("of a running tab starts one process", async () => {
    await withLifecycle(async ({ manager, processes, runningTab, spawned, tab, live }) => {
      const tabId = await runningTab();
      assert.equal(manager.restartTab(tabId, true), true);
      assert.equal(manager.restartTab(tabId, true), false);
      await spawned(2);
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 2);
      assert.equal(live(), 1);
      assert.equal(tab(tabId)?.status, "running");
    });
  });

  it("of a stopped tab starts one process", async () => {
    await withLifecycle(async ({ manager, processes, runningTab, spawned, tab, live }) => {
      const tabId = await runningTab();
      processes[0]?.exit();
      assert.equal(tab(tabId)?.status, "stopped");
      manager.restartTab(tabId);
      manager.restartTab(tabId);
      await spawned(2);
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 2);
      assert.equal(live(), 1);
    });
  });
});

describe("a tab acted on while its start is underway", () => {
  it("closed, spawns nothing and holds no run", async () => {
    await withLifecycle(async ({ manager, processes, heldTab }) => {
      const { tabId, open } = await heldTab();
      await manager.closeTabs([tabId]);
      open();
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 0);
      assert.equal((manager as unknown as { runs: Map<string, unknown> }).runs.size, 0);
    });
  });

  it("archived, reopened and fitted again, spawns one process", async () => {
    await withLifecycle(async ({ manager, processes, heldTab, spawned, tab, live }) => {
      const { tabId, open } = await heldTab();
      await manager.closeKeepingSessions([tabId]);
      await manager.reopenArchived(tabId);
      manager.handleResize(tabId, 80, 24);
      open();
      await spawned(1);
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 1);
      assert.equal(live(), 1);
      assert.equal(tab(tabId)?.status, "running");
    });
  });

  it("disposed with its repository or worktree, spawns nothing", async () => {
    await withLifecycle(async ({ manager, processes, heldTab }) => {
      const { open } = await heldTab();
      await manager.dispose();
      open();
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 0);
    });
  });

  it("opened in a terminal, spawns nothing beside it", async () => {
    await withLifecycle(async ({ manager, processes, heldTab, tab }) => {
      const { tabId, open } = await heldTab();
      await manager.openInTerminal(tabId);
      open();
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 0);
      assert.equal(tab(tabId)?.status, "stopped");
    });
  });
});

describe("a tab acted on while a restart's process quits", () => {
  it("closed, starts nothing more", async () => {
    await withLifecycle(async ({ manager, processes, runningTab, live }) => {
      const tabId = await runningTab();
      manager.restartTab(tabId, true);
      await manager.closeTabs([tabId]);
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 1);
      assert.equal(live(), 0);
      assert.deepEqual(manager.snapshot(), []);
    });
  });

  it("archived, starts nothing more", async () => {
    await withLifecycle(async ({ manager, processes, runningTab, live }) => {
      const tabId = await runningTab();
      manager.restartTab(tabId, true);
      await manager.closeKeepingSessions([tabId]);
      await eventually("the process quits", () => live() === 0);
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 1);
      assert.equal(manager.archivedSnapshot().length, 1);
    });
  });
});

describe("a running tab archived", () => {
  it("comes back waiting for its first start, as a tab never started does", async () => {
    await withLifecycle(async ({ manager, runningTab, spawned, tab, live }) => {
      const tabId = await runningTab();
      await manager.closeKeepingSessions([tabId]);
      await eventually("the process quits", () => live() === 0);
      assert.equal(manager.archivedSnapshot()[0]?.status, "ready");
      assert.deepEqual(await manager.reopenArchived(tabId), { ok: true });
      assert.equal(tab(tabId)?.status, "ready");
      assert.equal(manager.start(tabId), true, "tabs-start takes it");
      await spawned(2);
    });
  });
});

describe("a tab whose session could not be deleted", () => {
  it("comes back in no turn and starts at its next fit", async () => {
    await withLifecycle(async ({ manager, runningTab, spawned, tab, failRemoves, notices }) => {
      const tabId = await runningTab();
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', Date.now(), HOST_CALLER);
      failRemoves(true);
      await manager.closeTabs([tabId]);
      assert.equal(tab(tabId)?.status, "ready");
      assert.equal(tab(tabId)?.inTurn, false);
      assert.equal(notices.length, 1);
      failRemoves(false);
      manager.handleResize(tabId, 80, 24);
      await spawned(2);
    });
  });

  it("while open in a terminal stays stopped, so no fit runs a second process on it, and Restart takes it back", async () => {
    await withLifecycle(async ({ manager, processes, runningTab, spawned, tab, failRemoves }) => {
      const tabId = await runningTab();
      await manager.openInTerminal(tabId);
      failRemoves(true);
      await manager.closeTabs([tabId]);
      failRemoves(false);

      assert.equal(tab(tabId)?.status, "stopped");
      assert.equal(tab(tabId)?.openedInTerminal, true, "the window still asks before closing it");
      assert.equal(manager.start(tabId), false, "tabs-start starts nothing, and says so");
      manager.handleResize(tabId, 80, 24);
      await sleep(SETTLE_MS);
      assert.equal(processes.length, 1);

      assert.equal(manager.restartTab(tabId, true), true);
      await spawned(2);
      assert.equal(tab(tabId)?.openedInTerminal, undefined);
    });
  });

  it("closes for good once it can be deleted", async () => {
    await withLifecycle(async ({ manager, runningTab, failRemoves }) => {
      const tabId = await runningTab();
      await manager.openInTerminal(tabId);
      failRemoves(true);
      await manager.closeTabs([tabId]);
      failRemoves(false);
      await manager.closeTabs([tabId]);
      assert.deepEqual(manager.snapshot(), []);
    });
  });
});

describe("a tab opened in a terminal", () => {
  it("opens one and stops its tab", async () => {
    await withLifecycle(async ({ manager, runningTab, tab, log }) => {
      const tabId = await runningTab();
      await manager.openInTerminal(tabId);
      assert.deepEqual(log, ["terminal opened"]);
      assert.equal(tab(tabId)?.status, "stopped");
      assert.equal(tab(tabId)?.openedInTerminal, true);
    });
  });

  it("closed while its process stops, opens none on the session being deleted, and comes back as any tab where that fails", async () => {
    await withLifecycle(async ({ manager, runningTab, spawned, tab, failRemoves, log }) => {
      const tabId = await runningTab();
      failRemoves(true);
      await Promise.all([manager.openInTerminal(tabId), manager.closeTabs([tabId])]);
      failRemoves(false);
      assert.deepEqual(log, ["removed s1"]);
      assert.equal(tab(tabId)?.status, "ready");
      assert.equal(tab(tabId)?.openedInTerminal, undefined);
      manager.handleResize(tabId, 80, 24);
      await spawned(2);
    });
  });

  it("archived while its process stops, opens none", async () => {
    await withLifecycle(async ({ manager, runningTab, log }) => {
      const tabId = await runningTab();
      const opening = manager.openInTerminal(tabId);
      await manager.closeKeepingSessions([tabId]);
      await opening;
      assert.deepEqual(log, []);
      assert.equal(manager.archivedSnapshot()[0]?.openedInTerminal, undefined);
    });
  });

  it("whose process outlives the stop, opens none beside it, says so, and can be restarted once it left", async () => {
    await withLifecycle(async ({ manager, processes, runningTab, hangNext, spawned, tab, log, notices }) => {
      hangNext();
      const tabId = await runningTab();
      await manager.openInTerminal(tabId);
      assert.deepEqual(log, [], "two processes must not write one session");
      assert.equal(tab(tabId)?.openedInTerminal, undefined);
      assert.equal(notices.length, 1);
      assert.equal(tab(tabId)?.status, "running");

      processes[0]?.exit();
      assert.equal(tab(tabId)?.status, "stopped");
      assert.equal(manager.restartTab(tabId), true);
      await spawned(2);
    });
  });
});

describe("a turn across a restart", () => {
  it("ends with a process that left in time", async () => {
    await withLifecycle(async ({ manager, runningTab, spawned, tab }) => {
      const tabId = await runningTab();
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', Date.now(), HOST_CALLER);
      manager.restartTab(tabId, true);
      await spawned(2);
      assert.equal(tab(tabId)?.inTurn, false);
    });
  });

  it("stands with a process that outlived the stop: nothing starts beside it, and Restart works once it left", async () => {
    await withLifecycle(async ({ manager, processes, runningTab, hangNext, spawned, tab, notices }) => {
      hangNext();
      const tabId = await runningTab();
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', Date.now(), HOST_CALLER);
      assert.equal(manager.restartTab(tabId, true), true);
      await eventually("the notice", () => notices.length === 1, OUTLIVED_STOP_MS);
      assert.equal(processes.length, 1, "two processes must not write one session");
      assert.equal(tab(tabId)?.status, "running");
      assert.equal(tab(tabId)?.inTurn, true);

      processes[0]?.exit();
      assert.equal(tab(tabId)?.status, "stopped");
      assert.equal(tab(tabId)?.inTurn, false);
      assert.equal(manager.restartTab(tabId), true);
      await spawned(2);
    });
  });

  it("marked by a late report on a tab waiting to start, ends with that start", async () => {
    await withLifecycle(async ({ manager, runningTab, spawned, tab, live }) => {
      const tabId = await runningTab();
      await manager.closeKeepingSessions([tabId]);
      await eventually("the process quits", () => live() === 0);
      await manager.reopenArchived(tabId);
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', Date.now(), HOST_CALLER);
      assert.equal(tab(tabId)?.inTurn, true);
      manager.handleResize(tabId, 80, 24);
      await spawned(2);
      assert.equal(tab(tabId)?.inTurn, false);
    });
  });

  it("starts anew with what the new process reports", async () => {
    await withLifecycle(async ({ manager, runningTab, spawned, tab }) => {
      const tabId = await runningTab();
      manager.restartTab(tabId, true);
      await spawned(2);
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', Date.now(), HOST_CALLER);
      assert.equal(tab(tabId)?.inTurn, true);
    });
  });
});
