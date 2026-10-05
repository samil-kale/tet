import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { HOST_SIDE, SANDBOX_SIDE } from "../../src/shared/ctl-side";
import { PLATFORM } from "../../src/main/util/host-platform";
import { HOST_CALLER, SANDBOX_CALLER } from "../../src/main/ctl/caller-side";
import { tabControlToken } from "../../src/main/terminals/ctl-token";
import { SbxLocalStore } from "../../src/main/sbx/sbx-local";
import { SettingsStore } from "../../src/main/store/settings";
import { buildEnv, setControlEnv, setStoredEnv } from "../../src/main/terminals/pty";
import { HostSetups } from "../../src/main/terminals/host-setup";
import { ReconcileScheduler } from "../../src/main/terminals/reconcile-scheduler";
import { type SessionManagerCallbacks, TabSessionManager } from "../../src/main/terminals/session-manager";
import { CONTROL_ENV, type HookEvent } from "../../src/shared/ctl";
import type { TabDescriptor } from "../../src/shared/types/terminals";
import { eventually, tempDir } from "../helpers";
import { reportApplies, REPORT_STALE_MS } from "../../src/main/terminals/turn-order";

/** terminals/: a tab's turns and marks, its token and environment, when sessions are listed. */

const NO_CALLBACKS: SessionManagerCallbacks = {
  onTabs: () => undefined,
  onOutput: () => undefined,
  onStatus: () => undefined,
  onStartupProgress: () => undefined,
  onNotice: () => undefined
};

/**
 * Runs `use` on project "p" in a folder of its own with PATH empty: no agent's version check
 * passes and sbx is missing, so nothing is set up, listed or spawned. Everything goes after.
 */
async function withEmptyPath(
  callbacks: Partial<SessionManagerCallbacks>,
  use: (manager: TabSessionManager, project: string) => Promise<void> | void
): Promise<void> {
  const root = tempDir("tet-empty-path-");
  const project = path.join(root, "repo");
  fs.mkdirSync(project);
  const originalPath = process.env.PATH;
  process.env.PATH = path.join(root, "empty");
  const settings = new SettingsStore(root);
  const manager = new TabSessionManager({ ref: { projectId: "p" }, path: project, name: () => "repo" }, root, settings, new SbxLocalStore(root), new HostSetups(root, settings, () => undefined), {
    ...NO_CALLBACKS,
    ...callbacks
  });
  try {
    await use(manager, project);
  } finally {
    await manager.dispose();
    process.env.PATH = originalPath;
  }
}

/** Pieces of the main process needing no app and no server: the session manager's turns and
 *  reports, the control records and launchers, the agent PATH, and what the shell may open. */

describe("a turn's notification", () => {
  // A shell tab stands in for an agent: no version check and no sessions, so the manager starts
  // nothing.
  it("is left out for a tab on screen, and only while it is", async () => {
    const root = tempDir("tet-notification-");
    const settings = new SettingsStore(root);
    settings.patch({ notifications: { finished: true, waiting: true, idleReminder: true } });
    let pushed: TabDescriptor[] = [];
    const manager = new TabSessionManager({ ref: { projectId: "p" }, path: root, name: () => "repo" }, root, settings, new SbxLocalStore(root), new HostSetups(root, settings, () => undefined), {
      onTabs: (_projectId, tabs) => (pushed = tabs),
      onOutput: () => undefined,
      onStatus: () => undefined,
      onStartupProgress: () => undefined,
      onNotice: () => undefined
    });
    const { tabId } = manager.createTab("shell");
    let at = Date.now();
    const hook = (event: HookEvent) => manager.hookEvent(tabId, event, "{}", (at += 1000), HOST_CALLER);
    const waitingEvents = ["permission", "question", "idle"] as const;
    try {
      manager.setOnScreen([tabId]);
      assert.deepEqual(hook("prompt-submit"), { stdout: "" }, "nothing for the prompt: TET's system prompt went in once per session");
      assert.equal(hook("stop").notification, undefined, "a turn finished with its tab on screen");
      assert.notEqual(
        pushed.find((tab) => tab.tabId === tabId)?.finishedAt,
        undefined,
        "the mark is still set: whether it shows is the renderer's call"
      );
      for (const event of waitingEvents) {
        assert.equal(hook(event).notification, undefined, event);
      }

      // The renderer reports another tab on screen, or none (focus lost, a dialog up).
      for (const onScreen of [["new-other"], []]) {
        manager.setOnScreen(onScreen);
        hook("prompt-submit");
        assert.match(hook("stop").notification?.title ?? "", /Finished/, `on screen: [${onScreen.join(",")}]`);
        for (const event of waitingEvents) {
          assert.notEqual(hook(event).notification, undefined, `${event}, on screen: [${onScreen.join(",")}]`);
        }
      }
    } finally {
      await manager.dispose();
    }
  });
});

describe("a tab's reported session", () => {
  it("is ordered by when the reports were made: a late hook of the session left behind does not take it back", async () => {
    await withEmptyPath({}, (manager) => {
      const { tabId } = manager.createTab("claude");
      const at = Date.now();
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', at, HOST_CALLER);
      // `/clear`: the new session starts, while the old one's stop hook is still on its way.
      manager.hookEvent(tabId, "session-start", '{"session_id":"s2"}', at + 2000, HOST_CALLER);
      manager.hookEvent(tabId, "stop", '{"session_id":"s1"}', at + 1000, HOST_CALLER);
      assert.equal(manager.inspect().find((tab) => tab.tabId === tabId)?.reportedSessionId, "s2");
    });
  });
});

describe("a question reported answered", () => {
  it("clears the mark and leaves the turn running", async () => {
    await withEmptyPath({}, (manager) => {
      const { tabId } = manager.createTab("pi");
      const inspected = () => manager.inspect().find((tab) => tab.tabId === tabId);
      const at = Date.now();
      manager.hookEvent(tabId, "prompt-submit", "{}", at, HOST_CALLER);
      manager.hookEvent(tabId, "permission", "{}", at + 1000, HOST_CALLER);
      assert.notEqual(inspected()?.waitingAt, undefined);
      manager.hookEvent(tabId, "answered", "{}", at + 2000, HOST_CALLER);
      assert.equal(inspected()?.waitingAt, undefined);
      assert.equal(inspected()?.inTurn, true);
    });
  });
});

describe("a Claude Code turn leaving a background agent running", () => {
  it("keeps the tab working, without a notification, until the stop naming none", async () => {
    await withEmptyPath({}, (manager) => {
      const { tabId } = manager.createTab("claude");
      const inTurn = (): boolean | undefined => manager.inspect().find((tab) => tab.tabId === tabId)?.inTurn;
      const stop = (tasks: object[]): string => JSON.stringify({ session_id: "s1", background_tasks: tasks });
      const agent = { id: "a1", type: "subagent", status: "running" };
      const shell = { id: "b1", type: "shell", status: "running" };
      const at = Date.now();
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', at, HOST_CALLER);
      assert.deepEqual(manager.hookEvent(tabId, "stop", stop([agent, shell]), at + 1000, HOST_CALLER), { stdout: "{}" });
      assert.equal(inTurn(), true, "a background agent runs on");
      // Its end starts a turn of its own.
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', at + 2000, HOST_CALLER);
      manager.hookEvent(tabId, "stop", stop([shell]), at + 3000, HOST_CALLER);
      assert.equal(inTurn(), false, "a background shell alone does not count");
    });
  });
});

describe("a turn reported after its tab's process exited", () => {
  it("marks nothing: the report was sent before the exit and arrived after it", async () => {
    const statuses: string[] = [];
    // A tab in `error` without a process: sbx is missing, so its sandboxed start fails. A pty
    // spawned here would keep node's test runner from exiting (node-pty's pipes outlive the exit).
    await withEmptyPath({ onStatus: (_projectId, _tabId, status) => statuses.push(status) }, async (manager, project) => {
      fs.writeFileSync(path.join(project, "tet.json"), JSON.stringify({ sbx: { enabled: true } }));
      const { tabId } = manager.createTab("pi");
      manager.handleResize(tabId, 80, 24);
      await eventually(() => `an error after [${statuses.join(", ")}]`, () => statuses.at(-1) === "error", 10_000);
      const at = Date.now();
      manager.hookEvent(tabId, "prompt-submit", "{}", at, HOST_CALLER);
      assert.deepEqual(manager.hookEvent(tabId, "permission", "{}", at + 1000, HOST_CALLER), { stdout: "" });
      const inspected = manager.inspect().find((candidate) => candidate.tabId === tabId);
      assert.notEqual(inspected?.inTurn, true);
      assert.equal(inspected?.waitingAt, undefined);
    });
  });
});

describe("a tab of a missing agent", () => {
  it("starts once enabling SBX makes its agent startable", async () => {
    const statuses: string[] = [];
    const notices: string[] = [];
    const callbacks: Partial<SessionManagerCallbacks> = {
      onStatus: (_projectId, _tabId, status) => statuses.push(status),
      onNotice: (_severity, message) => notices.push(message)
    };
    // The start ends in sbx's notice, sbx being missing too.
    await withEmptyPath(callbacks, async (manager, project) => {
      const { tabId } = manager.createTab("pi");
      manager.handleResize(tabId, 80, 24);
      await eventually("the tab shows missing", () => statuses.at(-1) === "missing", 10_000);
      fs.writeFileSync(path.join(project, "tet.json"), JSON.stringify({ sbx: { enabled: true } }));
      await manager.sbxSettingsChanged(true);
      await eventually(() => `a start after [${statuses.join(", ")}]`, () => statuses.at(-1) === "error", 10_000);
      assert.ok(notices.some((notice) => notice.includes("only runs in repo's SBX sandbox")), notices.join("\n"));
    });
  });
});

describe("a sandboxed tab's control token", () => {
  it("differs from the same tab's on the host, so its limits outlive the tab", () => {
    const host = tabControlToken("run-token", { projectId: "p" }, "tab-1", HOST_SIDE);
    const sandboxed = tabControlToken("run-token", { projectId: "p" }, "tab-1", SANDBOX_SIDE);
    assert.notEqual(host, sandboxed);
    // Nothing is kept per tab: the control server reads the side back off whichever of the two
    // matches, so a process left in the sandbox is answered by the rules its tab started under
    // even once the tab and its project are closed.
  });
});

describe("a terminal's environment", () => {
  it("puts TET's own above the machine's, and a saved command's above all", () => {
    process.env.TET_TEST_MACHINE = "machine";
    process.env.TET_TEST_OUTER = "outer";
    setControlEnv({ TET_TEST_OUTER: "inner", TET_TEST_CONTROL: "control" }, "");
    const env = buildEnv({
      env: { TET_TEST_MACHINE: "default", TET_TEST_AGENT: "agent" },
      own: { TET_TEST_OWN: "own", TET_TEST_CONTROL: "own" },
      envOverride: { TET_TEST_OWN: "command" }
    });
    assert.equal(env.TET_TEST_MACHINE, "machine", "the machine's beats the agent's default");
    assert.equal(env.TET_TEST_AGENT, "agent", "the agent's default stands where the machine has none");
    // A TET started from its own shell tab has the outer app's value in process.env.
    assert.equal(env.TET_TEST_OUTER, "inner", "TET's own beats what an outer TET left");
    assert.equal(env.TET_TEST_CONTROL, "own", "the tab's own beats the app-wide");
    assert.equal(env.TET_TEST_OWN, "command", "a saved command's beats everything");
  });

  it("sets the variables kept in TET over the machine's own, and none in a sandbox", () => {
    process.env.TET_TEST_MACHINE = "machine";
    let stored: Record<string, string> = { TET_TEST_STORED: "first", TET_TEST_MACHINE: "stored" };
    setStoredEnv(() => stored);
    try {
      const env = buildEnv({ env: { TET_TEST_STORED: "agent" } });
      assert.equal(env.TET_TEST_STORED, "first", "above an agent's default");
      assert.equal(env.TET_TEST_MACHINE, "stored", "above the machine's own");
      assert.equal(buildEnv({ side: SANDBOX_CALLER }).TET_TEST_MACHINE, "machine", "a sandbox keeps the machine's");
      assert.equal(env.TET_KEPT_ENV, "TET_TEST_STORED,TET_TEST_MACHINE", "what it got from TET, named");
      stored = { TET_TEST_STORED: "second" };
      assert.equal(buildEnv({}).TET_TEST_STORED, "second", "read at every spawn, so a restart sees it");
      // A TET started from a tab of another inherits that one's list; its own tabs get their own.
      process.env.TET_KEPT_ENV = "OUTER";
      stored = {};
      assert.equal(buildEnv({}).TET_KEPT_ENV, undefined, "none kept, none named");
      delete process.env.TET_KEPT_ENV;
      assert.equal(buildEnv({ side: SANDBOX_CALLER }).TET_TEST_STORED, undefined, "a sandbox gets none");
    } finally {
      setStoredEnv(() => ({}));
    }
  });

  it("replaces the machine's variable spelled in another case, where names ignore case", { skip: !PLATFORM.envNamesIgnoreCase }, () => {
    process.env.TET_TEST_CASE = "machine";
    setStoredEnv(() => ({ tet_test_case: "stored" }));
    try {
      const env = buildEnv({});
      const names = Object.keys(env).filter((name) => name.toUpperCase() === "TET_TEST_CASE");
      assert.deepEqual(names.map((name) => env[name]), ["stored"], "one variable, TET's");
    } finally {
      setStoredEnv(() => ({}));
    }
  });

  it("gives a terminal its own tab's control token, never the run's", () => {
    setControlEnv({ [CONTROL_ENV.token]: "run-token" }, "");
    const env = buildEnv({ own: { [CONTROL_ENV.projectId]: "p1", [CONTROL_ENV.tabId]: "tab-1" } });
    assert.equal(env[CONTROL_ENV.token], tabControlToken("run-token", { projectId: "p1" }, "tab-1", HOST_SIDE));
    assert.notEqual(env[CONTROL_ENV.token], tabControlToken("run-token", { projectId: "p1" }, "tab-2", HOST_SIDE), "another tab's differs");
    const inSandbox = buildEnv({
      own: { [CONTROL_ENV.projectId]: "p1", [CONTROL_ENV.tabId]: "tab-1" },
      side: SANDBOX_CALLER
    });
    assert.equal(inSandbox[CONTROL_ENV.token], tabControlToken("run-token", { projectId: "p1" }, "tab-1", SANDBOX_SIDE), "the sandbox is in it");
    setControlEnv({}, "");
  });

  it("gives a worktree's terminal a token of that worktree, and no outer TET's ids", () => {
    setControlEnv({ [CONTROL_ENV.token]: "run-token" }, "");
    const inherited = { worktree: process.env[CONTROL_ENV.worktree], tab: process.env[CONTROL_ENV.tabId] };
    // A TET started from a worktree tab of another TET inherits that tab's ids.
    process.env[CONTROL_ENV.worktree] = "outer";
    process.env[CONTROL_ENV.tabId] = "outer-tab";
    try {
      const main = buildEnv({ own: { [CONTROL_ENV.projectId]: "p1", [CONTROL_ENV.tabId]: "tab-1" } });
      assert.equal(main[CONTROL_ENV.worktree], undefined, "the repository's tab names no worktree");
      const env = buildEnv({
        own: { [CONTROL_ENV.projectId]: "p1", [CONTROL_ENV.worktree]: "k3f9a2c1", [CONTROL_ENV.tabId]: "tab-1" }
      });
      assert.equal(env[CONTROL_ENV.worktree], "k3f9a2c1");
      assert.equal(env[CONTROL_ENV.token], tabControlToken("run-token", { projectId: "p1", worktree: "k3f9a2c1" }, "tab-1", HOST_SIDE));
      assert.notEqual(env[CONTROL_ENV.token], main[CONTROL_ENV.token], "the repository's tab of that id has another");
    } finally {
      for (const [name, value] of [[CONTROL_ENV.worktree, inherited.worktree], [CONTROL_ENV.tabId, inherited.tab]] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      setControlEnv({}, "");
    }
  });

  it("prepends the launcher directory to PATH under whatever name PATH has", () => {
    const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const before = process.env[key] ?? "";
    setControlEnv({}, "/tet/bin");
    const env = buildEnv({});
    assert.equal(env[key], `/tet/bin${path.delimiter}${before}`);
    assert.equal(Object.keys(env).filter((name) => name.toUpperCase() === "PATH").length, 1, "one PATH, not two");
  });

  it("lets a saved command's PATH replace one spelled Path, where names ignore case", { skip: !PLATFORM.envNamesIgnoreCase }, () => {
    setControlEnv({}, "");
    // A TET started from the desktop inherits `Path`; the spelling a tet.json uses is its own.
    const env = buildEnv({ own: { Path: "inherited" }, envOverride: { PATH: "command" } });
    const names = Object.keys(env).filter((name) => name.toUpperCase() === "PATH");
    assert.deepEqual(names.map((name) => env[name]), ["command"]);
  });
});

describe("when an agent's sessions are listed again", () => {
  /** A scheduler whose listings are counted, on the test's mocked clock. */
  const scheduler = (
    unsettled = false,
    working = false
  ): { schedule: (delayMs?: number) => void; watched: () => void; runs: () => number } => {
    let runs = 0;
    const reconciler = new ReconcileScheduler({
      reconcile: async () => {
        runs++;
      },
      titlesUnsettled: () => unsettled,
      working: () => working,
      disposed: () => false
    });
    return { schedule: (delayMs) => reconciler.schedule(delayMs), watched: () => reconciler.watched(), runs: () => runs };
  };

  it("keeps a watcher's early listing when output arrives before it is due", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { schedule, runs } = scheduler();
    schedule(300);
    schedule();
    t.mock.timers.tick(300);
    assert.equal(runs(), 1, "output did not push the watcher's listing back to its own debounce");
  });

  it("lists soon after a watcher's event outside a turn", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { watched, runs } = scheduler();
    watched();
    t.mock.timers.tick(300);
    assert.equal(runs(), 1);
  });

  it("debounces a turn's watcher events as output, into one listing once it goes quiet", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { watched, runs } = scheduler(false, true);
    watched();
    t.mock.timers.tick(4000);
    watched();
    t.mock.timers.tick(4000);
    assert.equal(runs(), 0, "still within the debounce of the last write");
    t.mock.timers.tick(1000);
    assert.equal(runs(), 1);
  });

  it("lists a turn's watcher events by the cap while a title is unknown", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { watched, runs } = scheduler(true, true);
    for (let elapsed = 0; elapsed < 10_000; elapsed += 1000) {
      watched();
      t.mock.timers.tick(1000);
    }
    assert.equal(runs(), 1);
  });

  it("debounces a burst of output into one listing once it goes quiet", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { schedule, runs } = scheduler();
    schedule();
    t.mock.timers.tick(4000);
    schedule();
    t.mock.timers.tick(4000);
    assert.equal(runs(), 0, "still within the debounce of the last chunk");
    t.mock.timers.tick(1000);
    assert.equal(runs(), 1);
  });

  it("lists by the cap however long the output keeps coming while a title is unknown", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { schedule, runs } = scheduler(true);
    for (let elapsed = 0; elapsed < 10_000; elapsed += 1000) {
      schedule();
      t.mock.timers.tick(1000);
    }
    assert.equal(runs(), 1);
  });
});

describe("which of two turn reports counts", () => {
  // Get this comparison backwards and a finished turn goes back to working.
  it("drops the one that lost the race, and takes one whose clock jumped backwards", () => {
    const now = Date.now();
    assert.equal(reportApplies(undefined, now), true, "nothing has been applied here yet");
    assert.equal(reportApplies(now, now), true, "the same moment still counts");
    assert.equal(reportApplies(now, now + 5), true, "newer than the last one");
    assert.equal(reportApplies(now, now - 200), false, "still in flight when the newer one landed");
    assert.equal(reportApplies(now, now - REPORT_STALE_MS - 1), true, "a clock that moved, not a race");
  });
});
