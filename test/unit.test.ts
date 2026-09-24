import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeLaunchers } from "../src/main/control/control-launcher";
import { ControlRecords } from "../src/main/control/control-records";
import { tabControlToken } from "../src/main/control/control-token";
import { augmentAgentPath, mergePath, npmGlobalPrefix, parseShellPath, shellInvocation, win32AgentDirs } from "../src/main/terminals/agent-path";
import { relativeInside } from "../src/main/path-inside";
import { resumableDownload } from "../src/main/resumable-download";
import { SbxLocalStore } from "../src/main/sbx-local";
import { SettingsStore } from "../src/main/settings";
import { isExecutableFile, isOpenableUrl } from "../src/main/shell-open";
import { buildEnv, setControlEnv, setStoredEnv } from "../src/main/terminals/pty";
import { ProjectSessionManager, type SessionManagerCallbacks } from "../src/main/terminals/session-manager";
import { CONTROL_ENV } from "../src/shared/control";
import type { HookEvent } from "../src/shared/control";
import type { TerminalDescriptor } from "../src/shared/types";
import { CLI, eventually } from "./helpers";

/** Pieces of the main process needing no app and no server: the session manager's turns and
 *  reports, the control records and launchers, the agent PATH, and what the shell may open. */

describe("a turn's toast", () => {
  // A shell tab stands in for an agent: no version check and no sessions, so the manager starts
  // nothing.
  it("is left out for a tab in front of the user, and only while it is", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tet-toast-"));
    const settings = new SettingsStore(root);
    settings.patch({ notifications: { finished: true, needsYou: true, idleReminder: true } });
    let pushed: TerminalDescriptor[] = [];
    const manager = new ProjectSessionManager({ id: "p", path: root, name: "repo" }, root, settings, new SbxLocalStore(root), {
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
  use: (manager: ProjectSessionManager, project: string) => Promise<void> | void
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tet-empty-path-"));
  const project = path.join(root, "repo");
  fs.mkdirSync(project);
  const originalPath = process.env.PATH;
  process.env.PATH = path.join(root, "empty");
  const manager = new ProjectSessionManager({ id: "p", path: project, name: "repo" }, root, new SettingsStore(root), new SbxLocalStore(root), {
    ...NO_CALLBACKS,
    ...callbacks
  });
  try {
    await use(manager, project);
  } finally {
    await manager.dispose();
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

describe("a tab's reported session", () => {
  it("is ordered by when the reports were made: a late hook of the session left behind does not take it back", async () => {
    await withEmptyPath({}, (manager) => {
      const { tabId } = manager.createTab("claude");
      const at = Date.now();
      manager.hookEvent(tabId, "prompt-submit", '{"session_id":"s1"}', at);
      // `/clear`: the new session starts, while the old one's stop hook is still on its way.
      manager.hookEvent(tabId, "session-start", '{"session_id":"s2"}', at + 2000);
      manager.hookEvent(tabId, "stop", '{"session_id":"s1"}', at + 1000);
      assert.equal(manager.inspect().find((tab) => tab.tabId === tabId)?.reportedSessionId, "s2");
    });
  });
});

describe("a tab of a missing agent", () => {
  it("starts once switching sandboxing on makes its agent startable", async () => {
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
      await manager.sbxConfigChanged();
      await eventually(() => `a start after [${statuses.join(", ")}]`, () => statuses.at(-1) === "error", 10_000);
      assert.ok(notices.some((notice) => /only runs in repo's SBX sandbox/.test(notice)), notices.join("\n"));
    });
  });
});

describe("a sandboxed tab's control token", () => {
  it("differs from the same tab's on the host, so its limits outlive the tab", () => {
    const host = tabControlToken("run-token", "p", "tab-1", false);
    const sandboxed = tabControlToken("run-token", "p", "tab-1", true);
    assert.notEqual(host, sandboxed);
    // Nothing is kept per tab: the control server reads the flag back off whichever of the two
    // matches, so a process left in the sandbox is answered by the rules its tab started under
    // even once the tab and its project are closed.
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

  it("sets the variables kept in TET over the machine's own, and none in a sandbox", () => {
    process.env.TET_TEST_MACHINE = "machine";
    let stored: Record<string, string> = { TET_TEST_STORED: "first", TET_TEST_MACHINE: "stored" };
    setStoredEnv(() => stored);
    try {
      const env = buildEnv({ env: { TET_TEST_STORED: "agent" } });
      assert.equal(env.TET_TEST_STORED, "first", "above an agent's default");
      assert.equal(env.TET_TEST_MACHINE, "stored", "above the machine's own");
      assert.equal(buildEnv({ sandboxed: true }).TET_TEST_MACHINE, "machine", "a sandbox keeps the machine's");
      assert.equal(env.TET_KEPT_ENV, "TET_TEST_STORED,TET_TEST_MACHINE", "what it got from TET, named");
      stored = { TET_TEST_STORED: "second" };
      assert.equal(buildEnv({}).TET_TEST_STORED, "second", "read at every spawn, so a restart sees it");
      // A tet started from a tab of another inherits that one's list; its own tabs get their own.
      process.env.TET_KEPT_ENV = "OUTER";
      stored = {};
      assert.equal(buildEnv({}).TET_KEPT_ENV, undefined, "none kept, none named");
      delete process.env.TET_KEPT_ENV;
      assert.equal(buildEnv({ sandboxed: true }).TET_TEST_STORED, undefined, "a sandbox gets none");
    } finally {
      setStoredEnv(() => ({}));
    }
  });

  it("replaces the machine's variable spelled in another case, where names ignore case", { skip: process.platform !== "win32" }, () => {
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
    assert.equal(env[CONTROL_ENV.token], tabControlToken("run-token", "p1", "tab-1", false));
    assert.notEqual(env[CONTROL_ENV.token], tabControlToken("run-token", "p1", "tab-2", false), "another tab's differs");
    const inSandbox = buildEnv({
      own: { [CONTROL_ENV.projectId]: "p1", [CONTROL_ENV.tabId]: "tab-1" },
      sandboxed: true
    });
    assert.equal(inSandbox[CONTROL_ENV.token], tabControlToken("run-token", "p1", "tab-1", true), "the sandbox is in it");
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

describe("an update's download, continued after it was cut short", () => {
  const BODY = Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => i % 251));

  /**
   * Serves BODY and records each request's Range. `cutAt`: the first response stops there and the
   * connection drops; `ignoreRange`: always the whole file; `wrongStart`: a 206 from byte 0.
   */
  async function releaseServer(mode: { cutAt?: number; ignoreRange?: boolean; wrongStart?: boolean }) {
    const ranges: (string | undefined)[] = [];
    const server = http.createServer((request, response) => {
      ranges.push(request.headers.range);
      const asked = mode.ignoreRange ? undefined : /^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1];
      if (asked !== undefined && Number(asked) >= BODY.length) {
        response.writeHead(416, { "Content-Range": `bytes */${BODY.length}` });
        response.end();
      } else if (asked !== undefined) {
        const start = mode.wrongStart ? 0 : Number(asked);
        response.writeHead(206, { "Content-Range": `bytes ${start}-${BODY.length - 1}/${BODY.length}`, "Content-Length": BODY.length - start });
        response.end(BODY.subarray(start));
      } else if (mode.cutAt !== undefined) {
        response.writeHead(200, { "Content-Length": BODY.length });
        response.write(BODY.subarray(0, mode.cutAt));
        mode.cutAt = undefined;
        // Long enough for the part to reach the disk.
        setTimeout(() => response.destroy(), 300);
      } else {
        response.writeHead(200, { "Content-Length": BODY.length });
        response.end(BODY);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/TET.zip`, ranges, close: () => server.close() };
  }

  const archive = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tet-download-test-")), "TET.zip");
  const signal = (): AbortSignal => AbortSignal.timeout(10_000);

  it("fetches the whole file when there is no part", async () => {
    const server = await releaseServer({});
    try {
      const file = archive();
      await resumableDownload(server.url, file, signal());
      assert.deepEqual(fs.readFileSync(file), BODY);
      assert.deepEqual(server.ranges, [undefined]);
    } finally {
      server.close();
    }
  });

  it("keeps the part of a dropped connection and asks only for the rest", async () => {
    const server = await releaseServer({ cutAt: 200 * 1024 });
    try {
      const file = archive();
      await assert.rejects(resumableDownload(server.url, file, signal()));
      const part = fs.statSync(file).size;
      assert.ok(part > 0 && part <= 200 * 1024, `part of ${part} bytes`);
      await resumableDownload(server.url, file, signal());
      assert.deepEqual(fs.readFileSync(file), BODY);
      assert.deepEqual(server.ranges, [undefined, `bytes=${part}-`]);
    } finally {
      server.close();
    }
  });

  it("overwrites the part when the server sends the whole file", async () => {
    const server = await releaseServer({ ignoreRange: true });
    try {
      const file = archive();
      fs.writeFileSync(file, BODY.subarray(0, 1000));
      await resumableDownload(server.url, file, signal());
      assert.deepEqual(fs.readFileSync(file), BODY);
      assert.deepEqual(server.ranges, ["bytes=1000-"]);
    } finally {
      server.close();
    }
  });

  it("leaves a complete file as it is", async () => {
    const server = await releaseServer({});
    try {
      const file = archive();
      fs.writeFileSync(file, BODY);
      await resumableDownload(server.url, file, signal());
      assert.deepEqual(fs.readFileSync(file), BODY);
    } finally {
      server.close();
    }
  });

  it("drops the part when the server answers another range", async () => {
    const server = await releaseServer({ wrongStart: true });
    try {
      const file = archive();
      fs.writeFileSync(file, BODY.subarray(0, 1000));
      await assert.rejects(resumableDownload(server.url, file, signal()), /bytes 0-/);
      assert.equal(fs.existsSync(file), false);
    } finally {
      server.close();
    }
  });
});
