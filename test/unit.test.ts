import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeLaunchers } from "../src/main/control/control-launcher";
import { ControlRecords } from "../src/main/control/control-records";
import { tabControlToken } from "../src/main/control/control-token";
import { augmentAgentPath, mergePath, npmGlobalPrefix, parseShellPath, shellInvocation, win32AgentDirs } from "../src/main/terminals/agent-path";
import { relativeInside } from "../src/main/path-inside";
import { SbxSecretStore } from "../src/main/sbx-secrets";
import { SettingsStore } from "../src/main/settings";
import { isExecutableFile, isOpenableUrl } from "../src/main/shell-open";
import { buildEnv, setControlEnv } from "../src/main/terminals/pty";
import { ProjectSessionManager } from "../src/main/terminals/session-manager";
import { CONTROL_ENV } from "../src/shared/control";
import type { HookEvent } from "../src/shared/control";
import type { TerminalDescriptor } from "../src/shared/types";
import { CLI, eventually } from "./helpers";

/** Pieces around the control channel needing no app and no server. */

describe("a turn's toast", () => {
  // A shell tab stands in for an agent: no version check and no sessions, so the manager starts
  // nothing.
  it("is left out for a tab in front of the user, and only while it is", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tet-toast-"));
    const settings = new SettingsStore(root);
    settings.save({ ...settings.get(), notifications: { finished: true, needsYou: true, idleReminder: true } });
    let pushed: TerminalDescriptor[] = [];
    const manager = new ProjectSessionManager({ id: "p", path: root, name: "repo" }, root, settings, new SbxSecretStore(root), {
      onTabs: (_projectId, tabs) => (pushed = tabs),
      onOutput: () => undefined,
      onStatus: () => undefined,
      onStartupProgress: () => undefined,
      onNotice: () => undefined
    });
    const { tabId } = manager.createTab("shell");
    let at = Date.now();
    const hook = (event: HookEvent) => manager.hookEvent(tabId, event, "{}", (at += 1000));
    const needsYou = ["permission", "question", "idle"] as const;
    try {
      manager.setInFront([tabId]);
      assert.deepEqual(hook("prompt-submit"), {}, "nothing for the prompt: TET's system prompt went in once per session");
      assert.equal(hook("stop").toast, undefined, "a turn finished in front of the user");
      assert.notEqual(
        pushed.find((tab) => tab.tabId === tabId)?.finishedAt,
        undefined,
        "the mark is still set: whether it shows is the renderer's call"
      );
      for (const event of needsYou) {
        assert.equal(hook(event).toast, undefined, event);
      }

      // The renderer reports another tab in front, or none (focus lost, a dialog up).
      for (const inFront of [["new-other"], []]) {
        manager.setInFront(inFront);
        hook("prompt-submit");
        assert.match(hook("stop").toast?.title ?? "", /Finished/, `in front: [${inFront}]`);
        for (const event of needsYou) {
          assert.notEqual(hook(event).toast, undefined, `${event}, in front: [${inFront}]`);
        }
      }
    } finally {
      await manager.dispose();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("a tab's reported session", () => {
  it("is ordered by when the reports were made: a late hook of the session left behind does not take it back", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tet-bind-"));
    // An empty PATH: Claude's version check fails, so nothing is set up, listed or spawned.
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(root, "empty");
    const manager = new ProjectSessionManager({ id: "p", path: root, name: "repo" }, root, new SettingsStore(root), new SbxSecretStore(root), {
      onTabs: () => undefined,
      onOutput: () => undefined,
      onStatus: () => undefined,
      onStartupProgress: () => undefined,
      onNotice: () => undefined
    });
    try {
      const { tabId } = manager.createTab("claude");
      const reported = () => manager.inspect().find((tab) => tab.tabId === tabId)?.reportedSessionId;
      const at = Date.now();
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', at);
      // `/clear`: the new session starts, while the old one's stop hook is still on its way.
      manager.hookEvent(tabId, "session-start", '{"session_id":"s2"}', at + 2000);
      manager.hookEvent(tabId, "stop", '{"session_id":"s1"}', at + 1000);
      assert.equal(reported(), "s2");
    } finally {
      await manager.dispose();
      process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("a tab of a missing agent", () => {
  it("starts once switching sandboxing on makes its agent startable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tet-missing-"));
    const project = path.join(root, "repo");
    fs.mkdirSync(project);
    // An empty PATH: pi is missing here, and so is sbx, so the start ends in sbx's notice.
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(root, "empty");
    const statuses: string[] = [];
    const notices: string[] = [];
    const manager = new ProjectSessionManager({ id: "p", path: project, name: "repo" }, root, new SettingsStore(root), new SbxSecretStore(root), {
      onTabs: () => undefined,
      onOutput: () => undefined,
      onStatus: (_projectId, _tabId, status) => statuses.push(status),
      onStartupProgress: () => undefined,
      onNotice: (_severity, message) => notices.push(message)
    });
    try {
      const { tabId } = manager.createTab("pi");
      manager.handleResize(tabId, 80, 24);
      await eventually("the tab shows missing", () => statuses.at(-1) === "missing", 10_000);
      fs.writeFileSync(path.join(project, "tet.json"), JSON.stringify({ sbx: { enabled: true } }));
      await manager.sbxConfigChanged();
      await eventually(() => `a start after [${statuses.join(", ")}]`, () => statuses.at(-1) === "error", 10_000);
      assert.ok(notices.some((notice) => /only runs in repo's SBX sandbox/.test(notice)), notices.join("\n"));
    } finally {
      await manager.dispose();
      process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("a terminal's environment", () => {
  it("puts tet's own above the machine's, and a saved command's above all", () => {
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
    // A tet started from its own shell tab has the outer app's value in process.env.
    assert.equal(env.TET_TEST_OUTER, "inner", "tet's own beats what an outer tet left");
    assert.equal(env.TET_TEST_CONTROL, "own", "the tab's own beats the app-wide");
    assert.equal(env.TET_TEST_OWN, "command", "a saved command's beats everything");
  });

  it("gives a terminal its own tab's control token, never the run's", () => {
    setControlEnv({ [CONTROL_ENV.token]: "run-token" }, "");
    const env = buildEnv({ own: { [CONTROL_ENV.projectId]: "p1", [CONTROL_ENV.tabId]: "tab-1" } });
    assert.equal(env[CONTROL_ENV.token], tabControlToken("run-token", "p1", "tab-1"));
    assert.notEqual(env[CONTROL_ENV.token], tabControlToken("run-token", "p1", "tab-2"), "another tab's differs");
    setControlEnv({}, "");
  });

  it("prepends the launcher directory to PATH under whatever name PATH has", () => {
    const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const before = process.env[key] ?? "";
    setControlEnv({}, "/tet/bin");
    const env = buildEnv({});
    assert.equal(env[key], `/tet/bin${path.delimiter}${before}`);
    assert.equal(Object.keys(env).filter((name) => name.toUpperCase() === "PATH").length, 1, "one PATH, not two");
  });

  it("lets a saved command's PATH replace one spelled Path, where names ignore case", { skip: process.platform !== "win32" }, () => {
    setControlEnv({}, "");
    // A tet started from the desktop inherits `Path`; the spelling a tet.json uses is its own.
    const env = buildEnv({ own: { Path: "inherited" }, envOverride: { PATH: "command" } });
    const names = Object.keys(env).filter((name) => name.toUpperCase() === "PATH");
    assert.deepEqual(names.map((name) => env[name]), ["command"]);
  });
});

describe("the tet-ctl launcher", () => {
  it("is found on PATH and runs the CLI", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-launcher-"));
    // Here `process.execPath` is node, which ignores ELECTRON_RUN_AS_NODE; the app writes electron.
    const bin = writeLaunchers(dir, CLI);
    const run = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      // cmd.exe resolves a .cmd on PATH and takes the line whole; a POSIX script needs no shell.
      const win32 = process.platform === "win32";
      const child = spawn(win32 ? "tet-ctl help" : "tet-ctl", win32 ? [] : ["help"], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, Path: undefined },
        shell: win32
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.on("close", (status) => resolve({ status, stdout }));
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /tet-ctl — control the TET app/);
  });

  it("leaves nothing set in the cmd.exe that ran it", { skip: process.platform !== "win32" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-launcher-"));
    const bin = writeLaunchers(dir, CLI);
    const after = await new Promise<string>((resolve) => {
      // One cmd.exe session: the launcher, then a look at the variable.
      const child = spawn(`call tet-ctl help >nul & set ELECTRON_RUN_AS_NODE`, [], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, Path: undefined, ELECTRON_RUN_AS_NODE: undefined },
        shell: true
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.on("close", () => resolve(stdout));
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.doesNotMatch(after, /ELECTRON_RUN_AS_NODE=1/);
  });
});

describe("a tab's recorded output", () => {
  it("keeps the latest output of open tabs only", () => {
    const records = new ControlRecords();
    records.addOutput("p1", "tab-1", "one");
    records.addOutput("p1", "tab-1", "two");
    records.addOutput("p1", "tab-2", "gone");
    records.addOutput("p2", "tab-3", "other project");
    records.keepOutputs("p1", new Set(["tab-1"]));
    assert.equal(records.output("p1", "tab-1"), "onetwo");
    assert.equal(records.output("p1", "tab-2"), undefined, "a closed tab's output goes with it");
    assert.equal(records.output("p2", "tab-3"), "other project", "another project's tabs untouched");
    records.forgetProject("p2");
    assert.equal(records.output("p2", "tab-3"), undefined, "a removed project's output goes with it");
  });

  it("holds the latest 256 KB of a tab", () => {
    const records = new ControlRecords();
    // A progress bar redrawn for hours, never a newline: bounded all the same.
    for (let i = 0; i < 400; i++) {
      records.addOutput("p", "shell", "\rDownloading 42%".padEnd(16 * 1024, " "));
      records.addOutput("p", "agent", "\x1b[H".padEnd(16 * 1024, "x"));
    }
    assert.equal(records.output("p", "shell")?.length, 256 * 1024);
    assert.equal(records.output("p", "agent")?.length, 256 * 1024);
  });
});

describe("the agent PATH", () => {
  it("appends only new directories, keeps order, and leaves an unchanged PATH alone", () => {
    assert.equal(mergePath("/a:/b", ["/c", "/b"], ":"), "/a:/b:/c", "the new one added, the present one not");
    assert.equal(mergePath("/a:/b", ["/b", "/a"], ":"), "/a:/b", "all present — the very same string");
    assert.equal(mergePath("", ["/a"], ":"), "/a", "an empty PATH takes the addition alone, no leading delimiter");
    assert.equal(mergePath("/a", [], ":"), "/a", "nothing to add");
    // The unix call: the shell's PATH is the base, so its node comes before the distro's.
    assert.equal(mergePath("/nvm/bin:/usr/bin", "/usr/bin:/usr/local/bin".split(":"), ":"), "/nvm/bin:/usr/bin:/usr/local/bin");
  });

  it("asks a Bourne shell as login and interactive, and csh the one way it allows", () => {
    assert.equal(shellInvocation("/bin/zsh")[0], "-ilc");
    assert.match(shellInvocation("/bin/zsh")[1], /^command printf/);
    assert.equal(shellInvocation("/bin/tcsh")[0], "-ic");
    assert.match(shellInvocation("/bin/tcsh")[1], /^printf/);
  });

  it("reads a moved npm prefix from the environment before ~/.npmrc, and nothing from neither", () => {
    assert.equal(npmGlobalPrefix({ NPM_CONFIG_PREFIX: "D:\\env" }, "prefix=D:\\rc"), "D:\\env");
    assert.equal(npmGlobalPrefix({}, "registry=https://x\r\n  prefix = D:\\rc  \r\n"), "D:\\rc");
    assert.equal(npmGlobalPrefix({ HOME: "D:\\h" }, "prefix=${HOME}\\npm"), "D:\\h\\npm", "expanded as npm expands it");
    assert.equal(npmGlobalPrefix({}, "prefix=${GONE}\\npm"), "${GONE}\\npm", "an unset variable stays, as in npm");
    assert.equal(npmGlobalPrefix({}, undefined), undefined);
  });

  it("reads the PATH the login shell printed between the markers, ignoring the noise around it", () => {
    assert.equal(parseShellPath("motd\n__TET_PATH_START__/usr/bin:/opt/bin__TET_PATH_END__\n"), "/usr/bin:/opt/bin");
    assert.equal(parseShellPath("a login banner with no markers"), undefined);
  });

  it("names npm's reported prefix, the manager roots from the environment, and the fixed shim dirs", () => {
    const j = (...p: string[]): string => p.join(path.sep);
    // Every manager's variable, plus npm's reported (moved) prefix.
    const full = win32AgentDirs(
      { APPDATA: j("C:", "u", "AppData", "Roaming"), LOCALAPPDATA: j("C:", "u", "AppData", "Local"), USERPROFILE: j("C:", "u"), NVM_SYMLINK: j("C:", "nvm", "node"), VOLTA_HOME: j("C:", "volta"), SCOOP: j("C:", "scoop") },
      j("D:", "npm-global")
    );
    assert.deepEqual(full, [
      j("D:", "npm-global"),
      j("C:", "u", "AppData", "Roaming", "npm"),
      j("C:", "nvm", "node"),
      j("C:", "volta", "bin"),
      j("C:", "scoop", "shims"),
      j("C:", "u", "AppData", "Local", "Microsoft", "WinGet", "Links"),
      j("C:", "u", "AppData", "Local", "DockerSandboxes", "bin")
    ]);
    // Nothing exported, no npm answer: the managers' default roots.
    const defaults = win32AgentDirs({ APPDATA: j("C:", "Roaming"), LOCALAPPDATA: j("C:", "Local"), USERPROFILE: j("C:", "u") }, undefined);
    assert.deepEqual(defaults, [
      j("C:", "Roaming", "npm"),
      j("C:", "Local", "Volta", "bin"),
      j("C:", "u", "scoop", "shims"),
      j("C:", "Local", "Microsoft", "WinGet", "Links"),
      j("C:", "Local", "DockerSandboxes", "bin")
    ]);
    // No empty entries.
    assert.deepEqual(win32AgentDirs({}, undefined), []);
  });

  // The login shell is asked to be interactive, and an interactive shell ignores SIGTERM: the
  // timeout must not rely on it, or the requirements check waits forever and the app never opens.
  it("gives up on a login shell that ignores being asked to stop", { skip: process.platform === "win32" && "posix only", timeout: 30_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-shell-"));
    const shell = path.join(dir, "hanging-shell");
    // Ignores SIGTERM and blocks in the shell itself, with no child to kill in its place.
    fs.writeFileSync(shell, ["#!/bin/sh", 'trap "" TERM', "read ignored", ""].join("\n"), { mode: 0o755 });
    const shellBefore = process.env.SHELL;
    const pathBefore = process.env.PATH;
    process.env.SHELL = shell;
    const started = Date.now();
    try {
      await augmentAgentPath();
    } finally {
      if (shellBefore === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = shellBefore;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const took = Date.now() - started;
    assert.ok(took < 20_000, `it waited ${took}ms on a shell it had given up on`);
    assert.equal(process.env.PATH, pathBefore, "a shell that answered nothing changes nothing");
  });
});

describe("a path inside a root", () => {
  const root = path.join(os.tmpdir(), "tet-root");

  it("is answered relative to the root", () => {
    assert.equal(relativeInside(root, path.join(root, "src", "a.ts")), path.join("src", "a.ts"));
  });

  it("counts a name that only starts with two dots as inside", () => {
    assert.equal(relativeInside(root, path.join(root, "..env")), "..env");
  });

  it("leaves out the root itself, its parent and its siblings", () => {
    assert.equal(relativeInside(root, root), undefined);
    assert.equal(relativeInside(root, path.dirname(root)), undefined);
    assert.equal(relativeInside(root, path.join(path.dirname(root), "other", "a.ts")), undefined);
  });
});

describe("what a ctrl-click hands the OS", () => {
  it("opens web and mail links only", () => {
    for (const url of ["https://example.com/a?b=c", "http://localhost:3000", "mailto:someone@example.com"]) {
      assert.equal(isOpenableUrl(url), true, url);
    }
    for (const url of ["file:///C:/Windows/System32/calc.exe", "ms-msdt://x", "vscode://file/a", "javascript://%0aalert(1)", "not a url"]) {
      assert.equal(isOpenableUrl(url), false, url);
    }
  });

  it("counts a program by its extension on Windows, and by its executable bit elsewhere", () => {
    for (const name of ["setup.EXE", "run.bat", "run.cmd", "a.ps1", "a.vbs", "a.js", "a.msi", "a.lnk"]) {
      assert.equal(isExecutableFile(path.join("dir", name), 0o644, "win32"), true, name);
    }
    assert.equal(isExecutableFile("notes.txt", 0o755, "win32"), false, "Windows has no executable bit");
    assert.equal(isExecutableFile("build", 0o755, "linux"), true);
    assert.equal(isExecutableFile("build.sh", 0o644, "linux"), true);
    assert.equal(isExecutableFile("app.desktop", 0o644, "linux"), true);
    assert.equal(isExecutableFile("run.command", 0o644, "darwin"), true);
    assert.equal(isExecutableFile("notes.txt", 0o644, "darwin"), false);
  });
});
