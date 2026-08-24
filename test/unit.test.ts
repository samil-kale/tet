import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeLaunchers } from "../src/main/control-launcher";
import { buildEnv, setControlEnv } from "../src/main/pty";
import { ShellContext } from "../src/main/shell-context";
import { CLI, eventually } from "./helpers";

/** The pieces around the control channel that need no app and no server: pure, or a file. */

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
      // The win32 BOM, stripped the way context-plugin.ts does.
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
