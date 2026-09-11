import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeLaunchers } from "../src/main/control/control-launcher";
import { augmentAgentPath, mergePath, npmGlobalPrefix, parseShellPath, shellInvocation, win32AgentDirs } from "../src/main/terminals/agent-path";
import { SettingsStore } from "../src/main/settings";
import { buildEnv, setControlEnv } from "../src/main/terminals/pty";
import { ProjectSessionManager } from "../src/main/terminals/session-manager";
import { ShellContext } from "../src/main/terminals/shell-context";
import type { HookEvent } from "../src/shared/control";
import type { TerminalDescriptor } from "../src/shared/types";
import { CLI, eventually } from "./helpers";

/** The pieces around the control channel that need no app and no server: pure, or a file. */

describe("a turn's toast", () => {
  // A shell tab stands in for an agent, as in app.test.ts: it has no version check and no
  // sessions to list, so the manager starts nothing, and the hook is about the tab.
  it("is left out for a tab in front of the user, and only while it is", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tet-toast-"));
    const settings = new SettingsStore(root);
    settings.save({ ...settings.get(), notifications: { finished: true, needsYou: true, idleReminder: true } });
    let pushed: TerminalDescriptor[] = [];
    const manager = new ProjectSessionManager({ id: "p", path: root, name: "repo" }, root, settings, {
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
      assert.notEqual(hook("prompt-submit").stdout, undefined, "the agent still gets its context");
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
      // The manager writes its context file on its own time; removed under it, the write logs.
      await eventually("the context file written", () => fs.existsSync(path.join(root, "projects", "p", "context.md")));
      await manager.dispose();
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
    // A tet started from one of its own shell tabs: the outer app's value is in process.env.
    assert.equal(env.TET_TEST_OUTER, "inner", "tet's own beats what an outer tet left");
    assert.equal(env.TET_TEST_CONTROL, "own", "the tab's own beats the app-wide");
    assert.equal(env.TET_TEST_OWN, "command", "a saved command's beats everything");
  });

  it("prepends the launcher directory to PATH under whatever name PATH has", () => {
    const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const before = process.env[key] ?? "";
    setControlEnv({}, "/tet/bin");
    const env = buildEnv({});
    assert.equal(env[key], `/tet/bin${path.delimiter}${before}`);
    assert.equal(Object.keys(env).filter((name) => name.toUpperCase() === "PATH").length, 1, "one PATH, not two");
  });
});

describe("the tet-ctl launcher", () => {
  it("is found on PATH and runs the CLI", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-launcher-"));
    // In here `process.execPath` is node, which ignores ELECTRON_RUN_AS_NODE — the same line
    // the app writes, with electron in that place.
    const bin = writeLaunchers(dir, CLI);
    const run = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      // cmd.exe is what resolves a .cmd on PATH, and it takes the line whole; a POSIX sh
      // script needs no shell to be found.
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
});

describe("the context file", () => {
  it("names tet-ctl from the start, and the shell log only once something ran", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-context-"));
    const context = new ShellContext(dir, "repo");
    const read = (): string => {
      const raw = fs.readFileSync(context.contextFile, "utf8");
      // The win32 BOM, stripped the way opencode's generated plugin does.
      return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    };
    await eventually("the first write", () => fs.existsSync(context.contextFile));
    assert.match(read(), /controlled with `tet-ctl`/);
    assert.doesNotMatch(read(), /Shell output/);

    context.append("tab-1", "build", "npm run build\r\ndone\r\n");
    await eventually("the shell paragraph", () => /Shell output/.test(read()));
    assert.match(read(), new RegExp(`shell tabs in repo: ${context.logFile.replace(/\\/g, "\\\\")}`));
    assert.doesNotMatch(read(), / KB\)/, "no size — it changes with every write");
    context.dispose();
    await eventually("the log", () => fs.existsSync(context.logFile) && /done/.test(fs.readFileSync(context.logFile, "utf8")));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps each shell tab's lines whole and marks where the writer changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-context-"));
    const context = new ShellContext(dir, "repo");
    context.append("tab-1", "build", "compiling");
    context.append("tab-2", "tab-2", "abc123 first commit\r\n");
    context.append("tab-1", "build", " main.ts\r\n");
    context.append("tab-1", "build", "unfinished");
    context.close("tab-1");
    context.dispose();
    await eventually("the log", () => fs.existsSync(context.logFile));
    assert.equal(
      fs.readFileSync(context.logFile, "utf8"),
      "=== shell tab: tab-2 ===\nabc123 first commit\n\n=== shell tab: build ===\ncompiling main.ts\nunfinished"
    );
    fs.rmSync(dir, { recursive: true, force: true });
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
    // Everything a manager exposes, plus what npm reported — the moved prefix included.
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
    // With nothing exported and no npm answer, it falls back to the managers' default roots.
    const defaults = win32AgentDirs({ APPDATA: j("C:", "Roaming"), LOCALAPPDATA: j("C:", "Local"), USERPROFILE: j("C:", "u") }, undefined);
    assert.deepEqual(defaults, [
      j("C:", "Roaming", "npm"),
      j("C:", "Local", "Volta", "bin"),
      j("C:", "u", "scoop", "shims"),
      j("C:", "Local", "Microsoft", "WinGet", "Links"),
      j("C:", "Local", "DockerSandboxes", "bin")
    ]);
    // A bare environment contributes only what it can name — no empty entries.
    assert.deepEqual(win32AgentDirs({}, undefined), []);
  });

  // What the timeout around the login shell is worth depends on the signal behind it: the shell is
  // asked to be interactive, and an interactive one ignores SIGTERM. Measured before the fix: the
  // call never came back, and with the requirements check waiting on it the app never opened.
  it("gives up on a login shell that ignores being asked to stop", { skip: process.platform === "win32" && "posix only", timeout: 30_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-shell-"));
    const shell = path.join(dir, "hanging-shell");
    // Ignores SIGTERM and blocks in the shell itself — no child that could be killed in its place.
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
