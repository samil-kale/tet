import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { findControlPort, startControlServer } from "../src/main/control/control-server";
import type { ControlDeps, ControlTerminals } from "../src/main/control/control-server";
import { CONTROL_ENV, EXIT_CODES } from "../src/shared/control";
import { EMPTY_REPOSITORY_STATE } from "../src/shared/types";
import type { AppSettings, Project, ProjectCommand, TerminalDescriptor } from "../src/shared/types";
import { eventually, tetCtl as runCli } from "./helpers";
import type { Run } from "./helpers";

/**
 * The control channel end to end below the app: the real server on a real loopback TCP port, the
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
  notified: [string, string][];
  hooks: [string, string, string][];
}

let tempDir: string;
let port: number;
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
    },
    hookEvent: (tabId, event, payload) => {
      calls.hooks.push([tabId, event, payload]);
      if (tabId !== OWN_TAB) {
        return {};
      }
      return event === "prompt-submit"
        ? { stdout: "<tet_context>the repository</tet_context>\n" }
        : { toast: { title: "Claude: Finished", body: "Finished in one" } };
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
    repositories: {
      get: (id) =>
        projects.some((project) => project.id === id)
          ? { getState: () => ({ ...EMPTY_REPOSITORY_STATE, head: `main-of-${id}` }) }
          : undefined
    },
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
    },
    notify: (title, body) => {
      calls.notified.push([title, body]);
    }
  };
}

/** The CLI as run from the caller's own tab of PROJECT; `env` overrides that. */
function tetCtl(args: string[], env: Record<string, string | undefined> = {}, input = ""): Promise<Run> {
  return runCli(
    args,
    {
      [CONTROL_ENV.port]: String(port),
      [CONTROL_ENV.token]: TOKEN,
      [CONTROL_ENV.projectId]: PROJECT.id,
      [CONTROL_ENV.tabId]: OWN_TAB,
      ...env
    },
    input
  );
}

describe("tet-ctl against the control server", () => {
  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-control-"));
    port = await findControlPort(tempDir);
    calls = {
      shown: [],
      closed: [],
      renamed: [],
      created: [],
      commands: [],
      added: [],
      removed: [],
      changed: [],
      shutdown: [],
      notified: [],
      hooks: []
    };
    server = await startControlServer(deps(), TOKEN, port);
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
      prompts: { commitMessage: "" }
    };
    for (const list of Object.values(calls)) {
      list.length = 0;
    }
  });

  it("answers help by itself, with every verb", async () => {
    const run = await tetCtl(["help"], { [CONTROL_ENV.port]: undefined });
    assert.equal(run.status, EXIT_CODES.ok);
    assert.match(run.stdout, /settings-set-theme <theme-id>/);
    assert.match(run.stdout, /restart-app --confirm/);
  });

  it("says where it is when not inside a tet terminal", async () => {
    const run = await tetCtl(["version"], { [CONTROL_ENV.port]: undefined });
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
    // Not through the CLI, which will not send it: the wire itself (HTTP, see control-server.ts
    // and tet-ctl.ts's own send — the one transport that also reaches the server from inside an
    // sbx sandbox).
    const http = await import("node:http");
    const body = await new Promise<string>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      );
      req.end(JSON.stringify({ token: TOKEN, verb: "help", args: {}, caller: {} }));
    });
    assert.equal(JSON.parse(body).error.code, "unknown_verb");
  });

  it("reports the version", async () => {
    assert.deepEqual((await tetCtl(["version"])).result, { version: "1.2.3", pid: 4242 });
  });

  it("lists the themes with system first", async () => {
    const run = await tetCtl(["list-themes"]);
    assert.equal(run.status, EXIT_CODES.ok);
    const ids = (run.result as { id: string }[]).map((theme) => theme.id);
    assert.deepEqual(ids, ["system", "dark-modern", "dark-slate", "light-modern"]);
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

  it("sets a prompt's text, puts tet's own back without one, and refuses an unknown id", async () => {
    const set = await tetCtl(["settings-set-prompt", "commitMessage", "write a subject"]);
    assert.deepEqual(set.result, { saved: true });
    assert.equal(settings.prompts.commitMessage, "write a subject");
    const reset = await tetCtl(["settings-set-prompt", "commitMessage"]);
    assert.equal(reset.status, EXIT_CODES.ok);
    assert.equal(settings.prompts.commitMessage, "");
    const unknown = await tetCtl(["settings-set-prompt", "commands", "x"]);
    assert.equal(unknown.status, EXIT_CODES.usage);
    assert.match(unknown.stderr, /unknown prompt: commands/);
  });

  it("acts on the caller's own project when none is given", async () => {
    const run = await tetCtl(["tabs-list"]);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.deepEqual(
      (run.result as TerminalDescriptor[]).map((entry) => entry.projectId),
      [PROJECT.id, PROJECT.id]
    );
  });

  it("answers the repository's state for the caller's project, or the one given", async () => {
    assert.equal(((await tetCtl(["repo-state"])).result as { head: string }).head, "main-of-p1");
    assert.equal(((await tetCtl(["repo-state", "--project", OTHER.id])).result as { head: string }).head, "main-of-p2");
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

  it("relays a notification to the process behind the control channel", async () => {
    assert.deepEqual((await tetCtl(["notify", "Codex: Finished", "Finished in repo"])).result, { notified: true });
    assert.deepEqual(calls.notified, [["Codex: Finished", "Finished in repo"]]);
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

  // The hook verb is the one an agent's own hooks run, so its stdout is the agent's, not a
  // person's: verbatim, and never a word of tet's own on top.
  it("hands a hook's payload over and answers with what the agent must see", async () => {
    const payload = '{"session_id":"abc","background_tasks":[]}';
    const run = await tetCtl(["hook", "prompt-submit"], {}, payload);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.equal(run.stdout, "<tet_context>the repository</tet_context>\n", "the answer, and nothing else");
    assert.deepEqual(calls.hooks, [[OWN_TAB, "prompt-submit", payload]]);
    assert.deepEqual(calls.notified, [], "nothing to toast about a prompt");
  });

  it("answers one JSON value where the event has nothing to say, and shows its toast", async () => {
    const run = await tetCtl(["hook", "stop"], {}, "{}");
    assert.equal(run.status, EXIT_CODES.ok);
    assert.equal(run.stdout, "{}", "Codex reads its Stop hook's stdout as JSON");
    assert.deepEqual(calls.notified, [["Claude: Finished", "Finished in one"]]);
  });

  // A prompt's answer is the prompt's own text, so a tab that is gone must add nothing to it —
  // not even the `{}` every other event answers with.
  it("says nothing at all into a prompt it has nothing for", async () => {
    const run = await tetCtl(["hook", "prompt-submit"], { [CONTROL_ENV.tabId]: "tab-gone" });
    assert.equal(run.status, EXIT_CODES.ok);
    assert.equal(run.stdout, "");
    assert.deepEqual(calls.hooks, [["tab-gone", "prompt-submit", ""]]);
  });

  it("carries a payload far bigger than any answer a person would read", async () => {
    // A Stop payload holds the whole last assistant message; 200 KB is a long but ordinary one.
    const payload = JSON.stringify({ session_id: "abc", last_assistant_message: "ü".repeat(200_000) });
    const run = await tetCtl(["hook", "stop"], {}, payload);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.deepEqual(calls.hooks, [[OWN_TAB, "stop", payload]], "whole and unmangled");
  });

  // Never the agent's problem: a non-zero exit or a stray line on stdout would land in the very
  // turn the hook was reporting.
  it("says nothing and fails nothing when the event, the tab or TET itself is not there", async () => {
    for (const [what, run] of [
      ["an unknown event", await tetCtl(["hook", "wat"])],
      ["no tab of its own", await tetCtl(["hook", "stop"], { [CONTROL_ENV.tabId]: undefined })],
      ["no TET at all", await tetCtl(["hook", "stop"], { [CONTROL_ENV.port]: undefined })]
    ] as const) {
      assert.equal(run.status, EXIT_CODES.ok, what);
      assert.equal(run.stdout, "", what);
      assert.equal(run.stderr, "", what);
    }
    assert.deepEqual(calls.hooks, [], "none of them reached a tab");
  });
});
