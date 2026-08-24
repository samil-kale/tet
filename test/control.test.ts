import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { controlSocketPath, startControlServer } from "../src/main/control-server";
import type { ControlDeps, ControlTerminals } from "../src/main/control-server";
import { CONTROL_ENV, EXIT_CODES } from "../src/shared/control";
import type { AppSettings, Project, ProjectCommand, TerminalDescriptor } from "../src/shared/types";
import { eventually, tetCtl as runCli } from "./helpers";
import type { Run } from "./helpers";

/**
 * The control channel end to end below the app: the real server on a real pipe or socket, the
 * real CLI as the child process an agent would run, and everything that needs electron faked
 * behind ControlDeps. Bundled into dist-test/ by esbuild.js; `npm test` runs it.
 */

const TOKEN = "test-token";

const PROJECT: Project = { id: "p1", path: "", name: "one" };
const OTHER: Project = { id: "p2", path: "", name: "two" };
const OWN_TAB = "tab-own";

function tab(projectId: string, tabId: string): TerminalDescriptor {
  return { tabId, projectId, agentId: "shell", title: "", status: "running" };
}

/** What every fake remembers of what the verbs did to it. */
interface Calls {
  shown: [string, string][];
  closed: string[];
  renamed: [string, string][];
  created: string[];
  commands: string[];
  added: string[];
  removed: string[];
  changed: { added?: string; removed?: string }[];
  shutdown: boolean[];
}

let tempDir: string;
let socketPath: string;
let server: { close: () => Promise<void> };
let settings: AppSettings;
let calls: Calls;

function terminalsOf(projectId: string): ControlTerminals {
  return {
    snapshot: () => [tab(projectId, OWN_TAB), tab(projectId, "tab-2")],
    createTab: (agentId) => {
      calls.created.push(agentId);
      return tab(projectId, "tab-new");
    },
    createCommandTab: (command: ProjectCommand) => {
      calls.commands.push(command.command);
      // The one a shell operator would have been refused for, see createCommandTab.
      return command.command.includes("&&") ? undefined : tab(projectId, "tab-cmd");
    },
    closeTabs: async (tabIds) => {
      calls.closed.push(...tabIds);
    },
    renameTab: async (tabId, title) => {
      calls.renamed.push([tabId, title]);
    }
  };
}

function deps(): ControlDeps {
  const projects = [PROJECT, OTHER];
  return {
    version: "1.2.3",
    pid: 4242,
    store: { list: () => projects, get: (id) => projects.find((project) => project.id === id) },
    settings: {
      get: () => settings,
      save: (next) => {
        settings = next;
      }
    },
    sessions: { get: (id) => (projects.some((project) => project.id === id) ? terminalsOf(id) : undefined) },
    listAgents: async () => [{ id: "shell", name: "Shell", installed: true }],
    agentIds: ["claude", "shell"],
    addProject: async (directory) => {
      calls.added.push(directory);
      return directory === "/nowhere" ? { error: "/nowhere is not a folder" } : { project: { id: "p3", path: directory, name: "three" } };
    },
    removeProject: (id) => {
      calls.removed.push(id);
    },
    readCommands: async () => [{ command: "npm run build", name: "build" }, { command: "a && b" }],
    shutdown: (relaunch) => {
      calls.shutdown.push(relaunch);
    },
    showTab: (projectId, tabId) => {
      calls.shown.push([projectId, tabId]);
    },
    projectsChanged: (change) => {
      calls.changed.push(change);
    }
  };
}

/** The CLI as run from the caller's own tab of PROJECT; `env` overrides that. */
function tetCtl(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  return runCli(args, {
    [CONTROL_ENV.socket]: socketPath,
    [CONTROL_ENV.token]: TOKEN,
    [CONTROL_ENV.projectId]: PROJECT.id,
    [CONTROL_ENV.tabId]: OWN_TAB,
    ...env
  });
}

describe("tet-ctl against the control server", () => {
  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-control-"));
    socketPath = controlSocketPath(tempDir);
    calls = {
      shown: [],
      closed: [],
      renamed: [],
      created: [],
      commands: [],
      added: [],
      removed: [],
      changed: [],
      shutdown: []
    };
    server = await startControlServer(deps(), TOKEN, socketPath);
  });

  after(async () => {
    await server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    settings = {
      notifications: { finished: true, needsYou: true, idleReminder: false },
      editorKeybindingPreset: "tet",
      theme: "system",
      themeAgents: { claude: true, opencode: true, codex: true }
    };
    for (const list of Object.values(calls)) {
      list.length = 0;
    }
  });

  it("answers help by itself, with every verb", async () => {
    const run = await tetCtl(["help"], { [CONTROL_ENV.socket]: undefined });
    assert.equal(run.status, EXIT_CODES.ok);
    assert.match(run.stdout, /settings-set-theme <theme-id>/);
    assert.match(run.stdout, /restart-app --confirm/);
  });

  it("says where it is when not inside a tet terminal", async () => {
    const run = await tetCtl(["version"], { [CONTROL_ENV.socket]: undefined });
    assert.equal(run.status, EXIT_CODES.internal);
    assert.match(run.stderr, /not inside a TET terminal/);
  });

  it("refuses a wrong token", async () => {
    const run = await tetCtl(["version"], { [CONTROL_ENV.token]: "other" });
    assert.equal(run.status, EXIT_CODES.unauthorized);
    assert.match(run.stderr, /not a terminal of this TET/);
  });

  it("refuses an unknown verb before connecting", async () => {
    const run = await tetCtl(["frobnicate"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /unknown verb: frobnicate/);
  });

  it("refuses a request the server does not know, even with a valid token", async () => {
    // Not through the CLI, which will not send it: the wire itself.
    const net = await import("node:net");
    const line = await new Promise<string>((resolve) => {
      const socket = net.connect(socketPath, () =>
        socket.write(JSON.stringify({ token: TOKEN, verb: "help", args: {}, caller: {} }) + "\n")
      );
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (data += chunk));
      socket.on("close", () => resolve(data));
    });
    assert.equal(JSON.parse(line).error.code, "unknown_verb");
  });

  it("reports the version", async () => {
    assert.deepEqual((await tetCtl(["version"])).result, { version: "1.2.3", pid: 4242 });
  });

  it("lists the themes with system first", async () => {
    const run = await tetCtl(["list-themes"]);
    assert.equal(run.status, EXIT_CODES.ok);
    const ids = (run.result as { id: string }[]).map((theme) => theme.id);
    assert.deepEqual(ids, ["system", "dark-modern", "light-modern"]);
  });

  it("sets a known theme and says a restart is needed, without restarting", async () => {
    const run = await tetCtl(["settings-set-theme", "light-modern"]);
    assert.deepEqual(run.result, { saved: true, restartRequired: true });
    assert.equal(settings.theme, "light-modern");
    assert.deepEqual(calls.shutdown, []);
  });

  it("refuses an unknown theme rather than storing it", async () => {
    const run = await tetCtl(["settings-set-theme", "solarized"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /unknown theme: solarized/);
    assert.equal(settings.theme, "system");
  });

  it("acts on the caller's own project when none is given", async () => {
    const run = await tetCtl(["tabs-list"]);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.deepEqual(
      (run.result as TerminalDescriptor[]).map((entry) => entry.projectId),
      [PROJECT.id, PROJECT.id]
    );
  });

  it("takes --project over the caller's own", async () => {
    const run = await tetCtl(["tabs-list", "--project", OTHER.id]);
    assert.equal((run.result as TerminalDescriptor[])[0].projectId, OTHER.id);
  });

  it("refuses an unknown project", async () => {
    const run = await tetCtl(["tabs-list", "--project", "p9"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /unknown project: p9/);
  });

  it("needs a project when the caller has none", async () => {
    const run = await tetCtl(["tabs-list"], { [CONTROL_ENV.projectId]: undefined });
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /pass --project/);
  });

  it("opens a tab and brings it to the front", async () => {
    const run = await tetCtl(["tabs-create", "--agent", "shell"]);
    assert.equal((run.result as TerminalDescriptor).tabId, "tab-new");
    assert.deepEqual(calls.created, ["shell"]);
    assert.deepEqual(calls.shown, [[PROJECT.id, "tab-new"]]);
  });

  it("refuses an agent it does not know", async () => {
    const run = await tetCtl(["tabs-create", "--agent", "gpt"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.deepEqual(calls.created, []);
  });

  it("runs a saved command by name, and by its command line", async () => {
    assert.equal(((await tetCtl(["tabs-run-command", "build"])).result as TerminalDescriptor).tabId, "tab-cmd");
    assert.equal((await tetCtl(["tabs-run-command", "npm run build"])).status, EXIT_CODES.ok);
    assert.deepEqual(calls.commands, ["npm run build", "npm run build"]);
    assert.equal(calls.shown.length, 2);
  });

  it("reports a saved command that cannot run, and one that does not exist", async () => {
    assert.equal((await tetCtl(["tabs-run-command", "a && b"])).status, EXIT_CODES.usage);
    const missing = await tetCtl(["tabs-run-command", "deploy"]);
    assert.equal(missing.status, EXIT_CODES.usage);
    assert.match(missing.stderr, /no saved command named deploy/);
  });

  it("closes another tab at once", async () => {
    const run = await tetCtl(["tabs-close", "tab-2"]);
    assert.deepEqual(run.result, { closed: "tab-2" });
    assert.deepEqual(calls.closed, ["tab-2"]);
  });

  it("answers before closing the caller's own tab", async () => {
    const run = await tetCtl(["tabs-close", OWN_TAB]);
    assert.deepEqual(run.result, { closed: OWN_TAB });
    await eventually("what the answer was followed by", () => calls.closed.includes(OWN_TAB));
  });

  it("refuses to close a tab it does not know", async () => {
    assert.equal((await tetCtl(["tabs-close", "tab-9"])).status, EXIT_CODES.usage);
    assert.deepEqual(calls.closed, []);
  });

  it("renames a tab", async () => {
    assert.deepEqual((await tetCtl(["tabs-rename", "tab-2", "Build log"])).result, { renamed: "tab-2" });
    assert.deepEqual(calls.renamed, [["tab-2", "Build log"]]);
  });

  it("refuses too many arguments", async () => {
    assert.equal((await tetCtl(["tabs-rename", "tab-2", "a", "b"])).status, EXIT_CODES.usage);
  });

  it("adds a project and tells the window which", async () => {
    const run = await tetCtl(["projects-add", tempDir]);
    assert.equal((run.result as Project).id, "p3");
    assert.deepEqual(calls.added, [tempDir]);
    assert.deepEqual(calls.changed, [{ added: "p3" }]);
  });

  it("passes on what adding a project had to say", async () => {
    const run = await tetCtl(["projects-add", "/nowhere"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /not a folder/);
    assert.deepEqual(calls.changed, []);
  });

  it("removes another project at once", async () => {
    assert.deepEqual((await tetCtl(["projects-remove", OTHER.id])).result, { removed: OTHER.id });
    assert.deepEqual(calls.removed, [OTHER.id]);
    assert.deepEqual(calls.changed, [{ removed: OTHER.id }]);
  });

  it("answers before removing the caller's own project", async () => {
    assert.deepEqual((await tetCtl(["projects-remove", PROJECT.id])).result, { removed: PROJECT.id });
    await eventually("what the answer was followed by", () => calls.removed.includes(PROJECT.id));
  });

  it("refuses to restart without --confirm", async () => {
    const run = await tetCtl(["restart-app"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /Ask the user/);
    assert.deepEqual(calls.shutdown, []);
  });

  it("answers, then restarts, with --confirm", async () => {
    assert.deepEqual((await tetCtl(["restart-app", "--confirm"])).result, { restarting: true });
    await eventually("what the answer was followed by", () => calls.shutdown.length === 1);
    assert.deepEqual(calls.shutdown, [true]);
  });
});

describe("the socket file", { skip: process.platform === "win32" && "named pipes leave nothing behind" }, () => {
  it("is taken over from a run that died, and freed on close", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-stale-"));
    const stale = controlSocketPath(dir);
    // A file nobody listens on, the way an unclean exit leaves one.
    fs.writeFileSync(stale, "");
    const taken = await startControlServer(deps(), TOKEN, stale);
    assert.ok(fs.statSync(stale).isSocket());
    await taken.close();
    assert.ok(!fs.existsSync(stale));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
