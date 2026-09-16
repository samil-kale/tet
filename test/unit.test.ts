import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeLaunchers } from "../src/main/control/control-launcher";
import { contextDirFor } from "../src/main/terminals/agent-data";
import { augmentAgentPath, mergePath, npmGlobalPrefix, parseShellPath, shellInvocation, win32AgentDirs } from "../src/main/terminals/agent-path";
import { relativeInside } from "../src/main/path-inside";
import { SettingsStore } from "../src/main/settings";
import { buildEnv, setControlEnv } from "../src/main/terminals/pty";
import { ProjectSessionManager } from "../src/main/terminals/session-manager";
import { ShellContext } from "../src/main/terminals/shell-context";
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
      // The manager writes its context file asynchronously; removed under it, the write logs.
      // Cleanup only, never a failure.
      await eventually("the context file written", () =>
        fs.existsSync(path.join(contextDirFor(root, "p"), "context.md"))
      ).catch(() => undefined);
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
    // A tet started from its own shell tab has the outer app's value in process.env.
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

describe("the context file", () => {
  it("names tet-ctl from the start, and how to read the shell tabs only once something ran", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-context-"));
    const context = new ShellContext(dir, "repo");
    const read = (): string => {
      const raw = fs.readFileSync(context.contextFile, "utf8");
      // The win32 BOM, stripped the way opencode's generated plugin does.
      return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    };
    await eventually("the first write", () => fs.existsSync(context.contextFile));
    assert.match(read(), /controlled with `tet-ctl`/);
    assert.doesNotMatch(read(), /tabs-shell-output/);

    context.append("tab-1", "npm run build\r\ndone\r\n");
    await eventually("the shell paragraph", () => /tabs-shell-output/.test(read()));
    assert.match(read(), /shell tabs in repo are read with `tet-ctl tabs-list`/);
    context.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps each shell tab's lines whole, and answers the last ones asked for", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-context-"));
    const context = new ShellContext(dir, "repo");
    context.append("tab-1", "compiling");
    context.append("tab-2", "abc123 first commit\r\n");
    context.append("tab-1", " main.ts\r\n");
    context.append("tab-1", "\x1b[32mok\x1b[0m\r\n40%\r80%\r100%\r\nunfinished");
    assert.equal(context.output("tab-1", 100), "compiling main.ts\nok\n100%\nunfinished", "the open line included");
    assert.equal(context.output("tab-1", 2), "100%\nunfinished");
    assert.equal(context.output("tab-2", 100), "abc123 first commit");
    context.close("tab-1");
    assert.equal(context.output("tab-1", 100), "", "a closed tab's lines go with it");
    context.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tries a failed write again by itself, and answers with the text meanwhile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-context-"));
    // A directory in the file's place makes the rename fail everywhere, as on win32 while a reader
    // holds the file without delete sharing.
    fs.mkdirSync(path.join(dir, "context.md"));
    const context = new ShellContext(dir, "repo");
    context.append("tab-1", "done\r\n");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.match(context.text, /tabs-shell-output/, "what the prompt-submit hook is answered with");
    fs.rmdirSync(context.contextFile);
    // No further output: only its own retry writes it.
    const written = (file: string, pattern: RegExp): boolean =>
      fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true && pattern.test(fs.readFileSync(file, "utf8"));
    await eventually("the retried write", () => written(context.contextFile, /tabs-shell-output/), 5000);
    context.dispose();
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
