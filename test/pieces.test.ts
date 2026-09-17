import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as esbuild from "esbuild";
import { hookTrustedHash, setupCodexHooks } from "../src/main/agents/codex/hooks";
import { hookSessionId } from "../src/main/agents/hook-payload";
import { renderOpencodePlugin, type OpencodePluginOptions } from "../src/main/agents/opencode/plugin";
import { renderPiExtension, writePiExtension } from "../src/main/agents/pi/extension";
import { TET_SYSTEM_PROMPT } from "../src/main/agents/system-prompt";
import { createByteThresholdCheck, createNonAsciiThresholdCheck } from "../src/main/terminals/session-ready";
import { reportApplies, SIGNAL_STALE_MS } from "../src/main/terminals/turn-order";
import { HOST_TARGET, SANDBOX_TARGET, toContainerPath } from "../src/main/terminals/hook-target";
import { stripAnsi } from "../src/shared/ansi";
import { shellSingleQuote } from "../src/shared/script-text";
import { ProjectStore } from "../src/main/projects";
import { readSbxConfig, writeSbxConfig } from "../src/main/git/commands";
import { contractHome, fixedMountSpecs, parsePublishedPorts, pathMountSpecs, sandboxName, saveSbxConfig } from "../src/main/sbx";
import { isMountAllowed, parseFilesystemRules, parseGovernance } from "../src/main/sbx-policy";
import { killProcessTree, resolveCommand } from "../src/main/terminals/pty";
import { SettingsStore } from "../src/main/settings";
import { installUncaughtHandler, UNCAUGHT_MARKER } from "../src/main/uncaught";
import { DEFAULT_PROMPTS, effectivePrompt } from "../src/shared/prompts";
import { THEMES } from "../src/shared/themes";
import { CONTROL_ENV } from "../src/shared/control";
import type { ControlRequest } from "../src/shared/control";
import { DEFAULT_KEYBINDING_PRESET_ID, EMPTY_SBX_CONFIG } from "../src/shared/types";
import type { SbxPort, SbxProjectConfig } from "../src/shared/types";
import { eventually } from "./helpers";

/** The small measured pieces, each one edit away from silently wrong. */

describe("Codex's hook trust", () => {
  // Verified against a real Codex install (see hooks.ts): a change here brings back the "Hooks
  // need review" screen.
  it("hashes the normalized hook the way Codex does", () => {
    assert.equal(
      hookTrustedHash("stop", "sh /tet/stop.sh"),
      "sha256:a6f28d9f053daa55c22c826e6aa4ad6ef89ae292a27d171ce959231dd740be62"
    );
    assert.equal(
      hookTrustedHash("pre_tool_use", "sh /tet/q.sh", "request_user_input"),
      "sha256:dea00f0554ef543a061c8aa314c4ffa0ab80a87ea327479fb17378136dcebb24"
    );
    assert.notEqual(hookTrustedHash("stop", "sh /tet/stop.sh"), hookTrustedHash("stop", "sh /tet/stop.sh", "x"));
  });

  it("hands every hook in as one TOML value with its trust entry, quoted literally", () => {
    const args = setupCodexHooks();
    const hooks = args[args.indexOf("-c") + 1];
    assert.match(hooks, /^hooks=\{SessionStart=\[/);
    for (const event of ["UserPromptSubmit", "Stop", "PermissionRequest", "PreToolUse"]) {
      assert.ok(hooks.includes(`${event}=[`), event);
    }
    assert.match(hooks, /matcher='request_user_input'/);
    const trusted = hooks.match(/trusted_hash='sha256:[0-9a-f]{64}'/g) ?? [];
    assert.equal(trusted.length, 5, "one per event, each its own handler");
    assert.ok(!args.some((arg) => arg.startsWith("hooks.")), "one value, never key paths");
  });

  it("registers one plain tet-ctl call per event, host and sandbox alike", () => {
    for (const target of [HOST_TARGET, SANDBOX_TARGET]) {
      const hooks = setupCodexHooks(target)[1];
      for (const event of ["session-start", "prompt-submit", "stop", "permission", "question"]) {
        assert.ok(hooks.includes(`command='tet-ctl hook ${event}'`), `${event} on ${target.posix ? "posix" : "win32"}`);
      }
      // No host path in a sandbox's trust key, and nothing written.
      assert.match(hooks, target.posix ? /'\/<session-flags>\/config\.toml:/ : /'C:\\<session-flags>\\config\.toml:/);
    }
  });
});

describe("resolveCommand", () => {
  it("spawns a native executable directly and routes a shim through cmd.exe", { skip: process.platform !== "win32" && "win32 only" }, () => {
    assert.deepEqual(resolveCommand("C:\\tools\\run.exe", ["-v"]), { command: "C:\\tools\\run.exe", args: ["-v"] });
    assert.deepEqual(resolveCommand("C:\\tools\\run.cmd", ["-v"]), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\tools\\run.cmd ^"-v^""'],
      windowsVerbatimArguments: true
    });
  });

  it("hands every character to a shim literally, through cmd.exe", { skip: process.platform !== "win32" && "win32 only" }, () => {
    // A global npm shim's shape (cmd-shim), in a folder whose name cmd.exe would otherwise split and
    // group; node by its path, where cmd-shim looks beside the shim or on PATH.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet shim (x)-"));
    const script = path.join(dir, "argv.js");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const shim = path.join(dir, "echo-args.cmd");
    fs.writeFileSync(
      shim,
      "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n" +
        `SET "_prog=${process.execPath}"\r\n` +
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\argv.js" %*\r\n'
    );
    const args = [
      // A quote cmd.exe sees as closing, then an operator: the shim's `%*` parses the line again.
      // First, since an argument with an odd count of quotes (`a\"b`) would hide what follows.
      'a"&echo INJECTED&"b', 'a">out.txt"', '{"k": 1}', "%VAR%",
      "plain", "", "a b", "a&b", "a>b", "a|b", "%PATH%", "a^b", 'say "hi"', "(x)", "!x!", "C:\\dir\\", "a\\\"b", "x;y,z", "ä€"
    ];
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      // The shim by its path, and by a bare name found on PATH.
      for (const program of [shim, "echo-args"]) {
        const resolved = resolveCommand(program, args);
        const run = spawnSync(resolved.command, resolved.args, {
          encoding: "utf8",
          windowsHide: true,
          windowsVerbatimArguments: resolved.windowsVerbatimArguments,
          cwd: dir
        });
        assert.deepEqual(JSON.parse(run.stdout), args, `${program}: ${run.stdout} ${run.stderr}`);
      }
    } finally {
      process.env.PATH = originalPath;
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ["argv.js", "echo-args.cmd"], "nothing redirected into a file");
  });

  it("hands a batch file reading its own arguments each one once escaped", { skip: process.platform !== "win32" && "win32 only" }, () => {
    // Maven's `mvn.cmd` shape: `%~1` compared in an `if`, where a second escape's carets are a
    // syntax error ("[tet] mvn exited with code 255").
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet batch (x)-"));
    try {
      const script = path.join(dir, "argv.js");
      fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const batch = path.join(dir, "mvn.cmd");
      fs.writeFileSync(
        batch,
        '@ECHO off\r\nIF "%~1" == "-f" (SET "kind=file") ELSE (SET "kind=other")\r\n' +
          `"${process.execPath}" "${script}" %kind% %*\r\n`
      );
      for (const [args, kind] of [[["process-classes", "exec:java", "a b"], "other"], [["-f", "pom.xml"], "file"]] as const) {
        const resolved = resolveCommand(batch, [...args]);
        const run = spawnSync(resolved.command, resolved.args, {
          encoding: "utf8",
          windowsHide: true,
          windowsVerbatimArguments: resolved.windowsVerbatimArguments,
          cwd: dir
        });
        assert.equal(run.status, 0, `${run.stdout} ${run.stderr}`);
        assert.deepEqual(JSON.parse(run.stdout), [kind, ...args]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a native executable named by its path without an extension", { skip: process.platform !== "win32" && "win32 only" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-native-"));
    try {
      fs.writeFileSync(path.join(dir, "build.exe"), "");
      assert.deepEqual(resolveCommand(path.join(dir, "build"), ["-v"]), { command: path.join(dir, "build.exe"), args: ["-v"] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills the program behind a shim along with its cmd.exe", { skip: process.platform !== "win32" && "win32 only" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-kill-"));
    const pidFile = path.join(dir, "pid");
    const script = path.join(dir, "wait.js");
    fs.writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const shim = path.join(dir, "wait.cmd");
    fs.writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const resolved = resolveCommand(shim, []);
    const child = spawn(resolved.command, resolved.args, { windowsHide: true, windowsVerbatimArguments: resolved.windowsVerbatimArguments, stdio: "ignore" });
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await eventually("the program started", () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "", 10_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    killProcessTree(child);
    await eventually("the program behind the shim exited", () => !alive(pid), 10_000);
  });

  it("takes a name's first folder on PATH, its extension second", { skip: process.platform !== "win32" && "win32 only" }, () => {
    // A shim put in front of an installed program: cmd.exe resolves per folder, every PATHEXT
    // extension before the next folder, so the earlier .cmd runs and not the later .exe.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-path-"));
    const [first, second] = [path.join(dir, "first"), path.join(dir, "second")];
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "tool.cmd"), "@ECHO off\r\n");
    fs.writeFileSync(path.join(second, "tool.exe"), "");
    const originalPath = process.env.PATH;
    process.env.PATH = [first, second].join(path.delimiter);
    try {
      assert.equal(resolveCommand("tool", []).command, "cmd.exe", "the .cmd in the first folder");
      process.env.PATH = [second, first].join(path.delimiter);
      assert.equal(resolveCommand("tool", []).command, path.join(second, "tool.exe"), "the .exe where its folder comes first");
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes nothing elsewhere", { skip: process.platform === "win32" && "not win32" }, () => {
    assert.deepEqual(resolveCommand("npm", ["-v"]), { command: "npm", args: ["-v"] });
  });
});

describe("sbx sandbox naming and mounts", () => {
  it("names a sandbox deterministically, within sbx create --name's own character set", () => {
    const name = sandboxName("a project id with spaces/slashes", "claude");
    assert.match(name, /^[a-z0-9][a-z0-9.-]+$/);
    assert.equal(name, sandboxName("a project id with spaces/slashes", "claude"), "stable across calls");
    assert.notEqual(name, sandboxName("a project id with spaces/slashes", "codex"), "one sandbox per agent too");
  });

  it("mounts a Windows path the way sbx does inside the sandbox, verified live 2026-09-08", {
    skip: process.platform !== "win32" && "win32 only"
  }, () => {
    assert.equal(toContainerPath("C:\\Users\\saka\\Documents\\Workspace\\Private\\tet"), "/c/Users/saka/Documents/Workspace/Private/tet");
  });

  it("spells a Windows path the way it is on disk, since sbx mounts it that way, verified live 2026-09-14", {
    skip: process.platform !== "win32" && "win32 only"
  }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tet-case-"));
    try {
      fs.mkdirSync(path.join(root, "tet"));
      const onDisk = toContainerPath(path.join(root, "tet", "not-yet-written.json"));
      assert.equal(toContainerPath(path.join(root, "TET", "not-yet-written.json")), onDisk);
      assert.match(onDisk, /\/tet\/not-yet-written\.json$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a macOS/Linux path untouched — already the same path inside and out", {
    skip: process.platform === "win32" && "not win32"
  }, () => {
    assert.equal(toContainerPath("/Users/saka/project"), "/Users/saka/project");
  });

  it("mounts rw bare (sbx maps it to the same path itself), ro with an explicit :ro target", () => {
    const repo = path.join(os.tmpdir(), "repo");
    assert.deepEqual(pathMountSpecs({ path: repo, access: "rw" }), { mount: repo, unmount: repo });
    const target = toContainerPath(repo);
    assert.deepEqual(pathMountSpecs({ path: repo, access: "ro" }), {
      mount: `${repo}:${target}:ro`,
      unmount: `${repo}:${target}`
    });
  });

  it("spells a single file exactly like a folder — sbx mounts either in both forms", () => {
    const file = path.join(os.tmpdir(), "repo", ".npmrc");
    assert.deepEqual(pathMountSpecs({ path: file, access: "rw" }), { mount: file, unmount: file });
    const target = toContainerPath(file);
    assert.deepEqual(pathMountSpecs({ path: file, access: "ro" }), {
      mount: `${file}:${target}:ro`,
      unmount: `${file}:${target}`
    });
  });

  it("stores a folder under the home as ~/…, and anything else as typed", () => {
    const home = os.homedir();
    assert.equal(contractHome(path.join(home, "data", "sub") + path.sep), "~/data/sub");
    assert.equal(contractHome(` ${home} `), "~");
    assert.equal(contractHome("~/already"), "~/already");
    // Not the temp dir: on win32 that sits under the home too.
    const elsewhere = path.join(path.parse(home).root, "elsewhere");
    assert.equal(contractHome(elsewhere), elsewhere);
    assert.equal(contractHome("relative/path"), "relative/path");
  });

  it("normalizes a typed host path (trimmed, ~ expanded) before building its mount spec", () => {
    const data = path.join(os.tmpdir(), "data");
    assert.equal(pathMountSpecs({ path: ` ${os.tmpdir()}${path.sep}data${path.sep} `, access: "rw" }).mount, data);
    const home = path.join(os.homedir(), "data");
    assert.equal(pathMountSpecs({ path: "~/data/", access: "rw" }).mount, home);
  });

  it("mounts tet's own dir live — agentDir read-write, nothing else", () => {
    const agentDir = path.join(os.tmpdir(), "agents", "claude", "p");
    assert.deepEqual(fixedMountSpecs({ agentDir }), [agentDir]);
  });
});

describe("a sandbox's published ports", () => {
  // `sbx ports <name> --json`, sbx 0.42.1 (2026-09-17), after publishing 38111:8080 and 38112:9090.
  const published = JSON.stringify([
    { host_ip: "127.0.0.1", host_port: 38111, sandbox_port: 8080, protocol: "tcp4" },
    { host_ip: "127.0.0.1", host_port: 38112, sandbox_port: 9090, protocol: "tcp4" }
  ]);

  it("reads the ports as the dialog spells them", () => {
    assert.deepEqual(parsePublishedPorts(published), [
      { host: "38111", container: "8080" },
      { host: "38112", container: "9090" }
    ]);
  });

  it("reads none where the sandbox has none, or says something else entirely", () => {
    // An empty list is `[]` (verified live); a stopped sandbox answers "No published ports" as text.
    assert.deepEqual(parsePublishedPorts("[]"), []);
    assert.deepEqual(parsePublishedPorts("No published ports\n"), []);
    assert.deepEqual(parsePublishedPorts(""), []);
    assert.deepEqual(parsePublishedPorts(JSON.stringify([{ host_ip: "127.0.0.1", protocol: "tcp4" }])), []);
  });
});

/**
 * The dialog's Save against a stand-in `sbx`, the one seam where the whole run is visible: what it
 * publishes is the delta against what the sandbox *has* (`sbx ports --json`), never against
 * tet.json's previous rows — those may list a port sbx refused at the last Save.
 */
describe("saving an sbx config", () => {
  const projectId = "a project with one sandbox";
  const name = sandboxName(projectId, "claude");
  // `sbx ports --publish` of a port another sandbox holds, sbx 0.42.1 (2026-09-17).
  const refusal = "ERROR: publish ports: 409 Conflict: request[0]: port 127.0.0.1:3000/tcp4 is already published\n";

  const port = (number: number): SbxPort => ({ host: String(number), container: String(number) });
  /** One entry of `sbx ports --json` (see "a sandbox's published ports"). */
  const listed = (number: number) => ({ host_ip: "127.0.0.1", host_port: number, sandbox_port: number, protocol: "tcp4" });
  const config = (ports: SbxPort[]): SbxProjectConfig => ({ ...EMPTY_SBX_CONFIG, enabled: true, ports });

  /**
   * A stand-in `sbx` first on PATH (a `.cmd` on win32, an `sh` script elsewhere): it appends every
   * invocation to a log, one line each, and answers the subcommands Save runs. It lists one
   * sandbox, this project's Claude one, so the other three agents are skipped; `policy ls` answers
   * no rules, so hosts add nothing to the log.
   */
  function fakeSbx(answers: { published: object[]; refuse?: string }): { dir: string; projectPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-sbx-save-"));
    const projectPath = path.join(dir, "repo");
    fs.mkdirSync(projectPath);
    const answerFile = path.join(dir, "answers.json");
    fs.writeFileSync(
      answerFile,
      JSON.stringify({ ...answers, refusal, name, workspaces: [projectPath], log: path.join(dir, "calls.log") })
    );
    const script = path.join(dir, "sbx.js");
    fs.writeFileSync(
      script,
      `const fs = require("node:fs");
const answers = JSON.parse(fs.readFileSync(${JSON.stringify(answerFile)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(answers.log, args.join(" ") + "\\n");
if (args[0] === "ls") {
  process.stdout.write(JSON.stringify({ sandboxes: [{ name: answers.name, workspaces: answers.workspaces }] }));
} else if (args[0] === "policy") {
  process.stdout.write(JSON.stringify({ rules: [] }));
} else if (args[0] === "ports" && args[2] === "--json") {
  process.stdout.write(JSON.stringify(answers.published));
} else if (args[2] === "--publish" && args[3] === answers.refuse) {
  process.stderr.write(answers.refusal);
  process.exit(1);
}
`
    );
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(dir, "sbx.cmd"), `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(dir, "sbx"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    }
    return { dir, projectPath };
  }

  /**
   * PATH with the stand-in first and every real `sbx` taken out: on win32 `resolveCommand` prefers a
   * native executable found anywhere on PATH to a `.cmd` in the first folder, so prepending alone
   * would still run the machine's own sbx.
   */
  function pathWith(dir: string): string {
    const holdsSbx = (entry: string): boolean =>
      entry !== "" && [".exe", ".com", ".cmd", ".bat", ""].some((extension) => fs.existsSync(path.join(entry, `sbx${extension}`)));
    return [dir, ...(process.env.PATH ?? "").split(path.delimiter).filter((entry) => !holdsSbx(entry))].join(path.delimiter);
  }

  /** Saves `now` over a tet.json holding `before`, against a sandbox that has `has` published. */
  async function save(setup: { has: number[]; before: number[]; now: number[]; refuse?: string }) {
    const { dir, projectPath } = fakeSbx({ published: setup.has.map(listed), refuse: setup.refuse });
    await writeSbxConfig(projectPath, config(setup.before.map(port)));
    const originalPath = process.env.PATH;
    process.env.PATH = pathWith(dir);
    try {
      const result = await saveSbxConfig(projectPath, projectId, config(setup.now.map(port)));
      const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split(/\r?\n/);
      return { result, projectPath, calls };
    } finally {
      process.env.PATH = originalPath;
    }
  }

  it("publishes a port tet.json already listed, because the sandbox never published it", async () => {
    const { result, calls } = await save({ has: [], before: [3000], now: [3000] });
    assert.deepEqual(calls, [
      "ls --json",
      "policy ls --type network --include-inactive --json",
      `exec -i ${name} true`,
      `ports ${name} --json`,
      `ports ${name} --publish 3000:3000`
    ]);
    assert.deepEqual(result, { removed: [], portFailures: [] });
  });

  it("unpublishes what the sandbox has and tet.json dropped, and leaves a port in both alone", async () => {
    const { calls } = await save({ has: [4000, 5000], before: [4000, 5000], now: [5000, 3000] });
    assert.deepEqual(
      calls.filter((call) => call.includes("publish")),
      [`ports ${name} --unpublish 4000:4000`, `ports ${name} --publish 3000:3000`]
    );
  });

  it("reports a refused publish under the agent's name, keeping the port in tet.json", async () => {
    const { result, projectPath } = await save({ has: [], before: [3000], now: [3000], refuse: "3000:3000" });
    assert.deepEqual(result.portFailures, [
      "The Claude sandbox could not publish port 3000:3000 (publish ports: 409 Conflict: request[0]: port 127.0.0.1:3000/tcp4 is already published)."
    ]);
    assert.deepEqual((await readSbxConfig(projectPath)).ports, [port(3000)]);
  });

  it("does not start the sandbox where no port is configured and none was", async () => {
    const { calls } = await save({ has: [], before: [], now: [] });
    assert.deepEqual(calls, ["ls --json", "policy ls --type network --include-inactive --json"]);
  });
});

describe("sbx's filesystem policy", () => {
  // `sbx policy ls --type filesystem --json` on an organization-governed account, sbx 0.42.1
  // (2026-09-14), trimmed to the fields read. `local` is an ungoverned account's active defaults.
  const governed = JSON.stringify({
    rules: [
      { resource_type: "filesystem:read", decision: "allow", resources: ["**"], status: "inactive" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["**"], status: "inactive" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["C:\\**"], status: "active" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["/**"], status: "active" }
    ],
    organization: "prehcmservice"
  });
  const local = JSON.stringify({
    rules: [
      { resource_type: "filesystem:read", decision: "allow", resources: ["**"], status: "active" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["**"], status: "active" }
    ]
  });
  const win32 = { platform: "win32" as const, home: "C:\\Users\\saka" };
  const posix = { platform: "linux" as const, home: "/home/saka" };
  const rules = (entries: object[]) => parseFilesystemRules(JSON.stringify({ rules: entries }));
  const allow = (type: string, resource: string) => ({ resource_type: type, decision: "allow", resources: [resource] });

  it("reads only active rules, and nothing out of what is not JSON", () => {
    assert.equal(parseFilesystemRules(governed).length, 2);
    assert.deepEqual(parseFilesystemRules("Not authenticated"), []);
  });

  it("lets an organization granting write alone mount read-write and read-only, as measured", () => {
    const measured = parseFilesystemRules(governed);
    assert.ok(isMountAllowed(measured, "C:\\Users\\saka\\.tet\\agent-data\\agents\\claude\\p", "rw", win32));
    assert.ok(isMountAllowed(measured, "C:\\Users\\saka\\.tet\\agent-data\\projects\\p", "ro", win32));
    assert.ok(!isMountAllowed(measured, "D:\\work", "rw", win32), "another drive matches no rule: default deny");
    assert.ok(isMountAllowed(measured, "/home/saka/work", "rw", posix));
  });

  it("allows everything under the local defaults' bare **", () => {
    assert.ok(isMountAllowed(parseFilesystemRules(local), "D:\\anywhere\\at\\all", "rw", win32));
    assert.ok(isMountAllowed(parseFilesystemRules(local), "/anywhere", "ro", posix));
  });

  it("matches * within one segment, ** at any depth and the folder itself", () => {
    const one = rules([allow("filesystem:write", "C:\\data\\*")]);
    assert.ok(isMountAllowed(one, "C:\\data\\project", "rw", win32));
    assert.ok(!isMountAllowed(one, "C:\\data\\project\\src", "rw", win32));
    const deep = rules([allow("filesystem:write", "C:\\data\\**")]);
    assert.ok(isMountAllowed(deep, "C:\\data\\project\\src", "rw", win32));
    assert.ok(isMountAllowed(deep, "C:\\data", "rw", win32));
    assert.ok(!isMountAllowed(deep, "C:\\database", "rw", win32));
  });

  it("expands ~ and *: for any drive, and ignores case on win32 alone", () => {
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "~\\.tet\\agent-data\\**")]), "C:\\Users\\saka\\.tet\\agent-data\\agents", "rw", win32));
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "~/**")]), "/home/saka/tet", "rw", posix));
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "*:\\data\\**")]), "E:\\data\\x", "rw", win32));
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "c:\\USERS\\**")]), "C:\\Users\\saka", "rw", win32));
    assert.ok(!isMountAllowed(rules([allow("filesystem:write", "/Home/**")]), "/home/saka", "rw", posix));
  });

  it("needs write for read-write, and lets a deny outrank every allow", () => {
    const readOnly = rules([allow("filesystem:read", "/data/**")]);
    assert.ok(isMountAllowed(readOnly, "/data/x", "ro", posix));
    assert.ok(!isMountAllowed(readOnly, "/data/x", "rw", posix));
    const denied = rules([allow("filesystem", "/**"), { resource_type: "filesystem:read", decision: "deny", resources: ["/data/secret/**"] }]);
    assert.ok(isMountAllowed(denied, "/data/open", "rw", posix));
    assert.ok(!isMountAllowed(denied, "/data/secret/x", "ro", posix));
    assert.ok(!isMountAllowed(denied, "/data/secret/x", "rw", posix), "a read deny stops a writable mount too");
  });
});

describe("sbx's governance line", () => {
  it("names the organization of a governed account, nothing for an ungoverned one", () => {
    // `sbx policy ls` on an organization-governed account, sbx 0.42.1 (2026-09-17).
    const governed = [
      "Governance: Managed by prehcmservice | Sync: OK, last synced 08:18:18 | Hidden: 34 inactive rules. Show with: sbx policy ls --include-inactive",
      "",
      "POLICY      SOURCE   APPLIES TO   SUMMARY",
      "ALLOW ALL   org      all          filesystem write: 2 allow"
    ].join("\r\n");
    assert.equal(parseGovernance(governed), "prehcmservice");
    assert.equal(parseGovernance("Governance: managed by unknown organization (lookup failed)"), "unknown organization (lookup failed)");
    assert.equal(parseGovernance("POLICY    SOURCE   APPLIES TO   SUMMARY\nbalanced  local    all          network: 40 allow"), undefined);
  });
});

describe("stripping escape sequences", () => {
  it("removes CSI with any parameter bytes, OSC ended either way and two-byte escapes", () => {
    const text = "\x1b[1;31mred\x1b[0m \x1b[>4;1mkeys\x1b[<u \x1b]0;title\x07a\x1b]8;;url\x1b\\b \x1bMc\x1b[?25h";
    assert.equal(stripAnsi(text), "red keys ab c");
  });
});

describe("the quoting helpers", () => {
  it("make any value one literal word in their shell", () => {
    assert.equal(shellSingleQuote("it's $HOME"), `'it'\\''s $HOME'`);
  });
});

describe("the stores", () => {
  it("read a hand-edited settings file field by field", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-settings-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{ nope");
    assert.equal(new SettingsStore(dir).get().colorScheme, "system");
    fs.writeFileSync(
      file,
      JSON.stringify({
        notifications: { finished: false, needsYou: "yes" },
        colorScheme: "sepia",
        darkTheme: "solarized",
        editorKeybindingPreset: "",
        prompts: { commitMessage: DEFAULT_PROMPTS.commitMessage, commands: "removed setting" }
      })
    );
    const settings = new SettingsStore(dir).get();
    assert.deepEqual(settings.notifications, { finished: false, needsYou: true, idleReminder: false });
    assert.equal(settings.colorScheme, "system");
    assert.equal(settings.darkTheme, "solarized", "an unknown id is left standing for the readers to fall back from");
    assert.equal(settings.lightTheme, "light-modern");
    assert.equal(settings.editorKeybindingPreset, DEFAULT_KEYBINDING_PRESET_ID);
    assert.deepEqual(settings.prompts, { commitMessage: "" }, "tet's own text spelled out is stored as none");
    assert.equal(effectivePrompt(settings.prompts, "commitMessage"), DEFAULT_PROMPTS.commitMessage);
    assert.equal(effectivePrompt({ commitMessage: "write a subject" }, "commitMessage"), "write a subject");
    const store = new SettingsStore(dir);
    store.save({ ...settings, colorScheme: "light" });
    assert.equal(new SettingsStore(dir).get().colorScheme, "light", "written whole and read back");
  });

  it("read the one theme of an older settings file as its kind and that kind's theme", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-settings-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ theme: "dark-slate" }));
    const picked = new SettingsStore(dir).get();
    assert.deepEqual(
      [picked.colorScheme, picked.darkTheme, picked.lightTheme],
      ["dark", "dark-slate", "light-modern"]
    );
    fs.writeFileSync(file, JSON.stringify({ theme: "system" }));
    const system = new SettingsStore(dir).get();
    assert.deepEqual([system.colorScheme, system.darkTheme, system.lightTheme], ["system", "dark-modern", "light-modern"]);
    assert.equal("theme" in system, false, "not written back");
  });

  it("keep only well-formed projects, deduplicate by path and reorder what they know", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-projects-"));
    const pathOf = (name: string): string => path.resolve(path.sep, name);
    fs.writeFileSync(
      path.join(dir, "projects.json"),
      JSON.stringify([
        { id: "a", path: pathOf("a"), name: "a" },
        { id: "b", path: pathOf("b") },
        "junk",
        { id: "c", path: pathOf("c"), name: "c" }
      ])
    );
    const store = new ProjectStore(dir);
    assert.deepEqual(store.list().map((project) => project.id), ["a", "c"]);
    assert.equal(store.add(pathOf("a")).id, "a", "already open");
    const added = store.add(path.join(dir, "repo"));
    assert.equal(added.name, "repo");
    store.reorder(["nope", added.id]);
    assert.deepEqual(store.list().map((project) => project.id), [added.id, "a", "c"], "unknown dropped, omitted kept behind");
    assert.equal(new ProjectStore(dir).list().length, 3, "persisted");
    assert.deepEqual(fs.readdirSync(dir), ["projects.json"], "renamed into place, no temporary file left");
  });
});

describe("session readiness checks", () => {
  it("counts plain bytes across chunks", () => {
    const ready = createByteThresholdCheck(10);
    assert.equal(ready("12345"), false);
    assert.equal(ready("12345"), false);
    assert.equal(ready("1"), true);
  });

  it("counts only non-ASCII characters, ignoring escape codes and blank fills", () => {
    const ready = createNonAsciiThresholdCheck(1);
    // opencode's blank repaint while it waits on its model list: escape codes and spaces only.
    assert.equal(ready("\x1b[38;2;255;255;255m\x1b[H" + " ".repeat(4800)), false);
    assert.equal(ready("\x1b[38;2;255;255;255m\x1b[H" + " ".repeat(4800)), false);
    // A real frame: two box-drawing characters clear the threshold.
    assert.equal(ready("▄"), false);
    assert.equal(ready("▄"), true);
  });
});

/**
 * A stand-in control server plus a tab's environment, for a generated plugin or extension to
 * report to. Reports are fire-and-forget, so a test waits for them rather than awaiting the call.
 */
async function controlChannel(): Promise<{ reports: ControlRequest[]; close: () => Promise<void> }> {
  const reports: ControlRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      reports.push(JSON.parse(body) as ControlRequest);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { stdout: "{}" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  process.env[CONTROL_ENV.port] = String((server.address() as { port: number }).port);
  process.env[CONTROL_ENV.token] = "test-token";
  process.env[CONTROL_ENV.projectId] = "p1";
  process.env[CONTROL_ENV.tabId] = "tab-1";
  return {
    reports,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function reported(reports: ControlRequest[]): string[] {
  return reports.map((report) => String(report.args.event));
}

describe("the session a hook report names", () => {
  // Trimmed from what the real hooks wrote to stdin (Claude Code 2.1.270, Codex 0.154.0).
  it("is read off Claude Code's and Codex's payloads alike", () => {
    const claude = `{"session_id":"e1ddb9cf-df0f-40b3-82b2-1343910fc3e4","transcript_path":"C:\\\\x.jsonl","hook_event_name":"UserPromptSubmit","prompt":"ok"}`;
    const codex = `{"session_id":"01a09f45-f0d2-74e1-be90-a8f79f43cb7e","turn_id":"01a09f45-f15d-77e1-b1d3-5375a8ce98d5","hook_event_name":"Stop"}`;
    assert.equal(hookSessionId(claude), "e1ddb9cf-df0f-40b3-82b2-1343910fc3e4");
    assert.equal(hookSessionId(codex), "01a09f45-f0d2-74e1-be90-a8f79f43cb7e");
    for (const nothing of ["", "{}", "null", "not json", `{"session_id":"  "}`, `{"session_id":7}`]) {
      assert.equal(hookSessionId(nothing), undefined, nothing);
    }
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
    assert.equal(reportApplies(now, now - SIGNAL_STALE_MS - 1), true, "a clock that moved, not a race");
  });
});

describe("TET's system prompt", () => {
  // It goes through cmd.exe, `sbx run` and a TOML basic string as measured — only as the plain
  // line it was measured as (system-prompt.ts).
  it("stays one line of letters, digits and plain punctuation", () => {
    assert.match(TET_SYSTEM_PROMPT, /^[A-Za-z0-9 .,;:'-]+$/);
  });
});

describe("pi's extension", () => {
  // pi exits outright on an extension that does not compile.
  it("compiles as TypeScript", () => {
    assert.doesNotThrow(() => esbuild.transformSync(renderPiExtension(), { loader: "ts" }));
  });

  it("reports both ends of a turn and a question", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-pi-ext-"));
    const channel = await controlChannel();
    try {
      const source = renderPiExtension();
      const compiled = path.join(dir, "tet.js");
      fs.writeFileSync(compiled, esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code);
      const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
      (createRequire(__filename)(compiled) as { default: (pi: unknown) => void }).default({
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers[event] = handler;
        }
      });

      assert.equal(handlers.before_agent_start, undefined, "the system prompt comes from pi's own flag");
      const ctx = { sessionManager: { getSessionId: () => "019eba31-566c-7911-bf09-14afe53d7c36" } };
      handlers.agent_start({}, ctx);
      handlers.agent_settled({}, ctx);
      handlers.ui_prompt_start({}, {});
      await eventually("all three reported", () => channel.reports.length === 3, 3000);
      assert.deepEqual(reported(channel.reports), ["prompt-submit", "stop", "permission"]);
      // The tab is the address; the session goes along to bind the tab to it.
      assert.deepEqual(channel.reports[0].caller, { projectId: "p1", tabId: "tab-1" });
      assert.equal(hookSessionId(String(channel.reports[0].args.payload)), "019eba31-566c-7911-bf09-14afe53d7c36");
      assert.equal(hookSessionId(String(channel.reports[2].args.payload)), undefined, "a context without a session");
      assert.equal(channel.reports[0].verb, "hook");
      // Reports are not awaited and race; tet orders them by the time each carries.
      assert.ok(
        channel.reports.every((report) => typeof report.at === "number" && report.at > 0),
        "every report says when it was made"
      );
    } finally {
      await channel.close();
    }
  });

  // Written on the host, read inside a container too: nothing in it may depend on where it runs.
  it("writes one file that reads the channel from its environment", () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-pi-sbx-"));
    const file = writePiExtension(storageDir);
    const source = fs.readFileSync(file, "utf8");

    assert.equal(file, path.join(storageDir, "tet", "index.ts"), "pi lists it by its folder's name");
    assert.deepEqual(fs.readdirSync(path.join(storageDir, "tet")), ["index.ts"], "no notify script, no marker directories");
    assert.ok(source.includes(JSON.stringify(CONTROL_ENV)), "the channel is read from the environment, not baked in");
  });
});

describe("opencode's plugin", () => {
  const nasty = "C:\\Users\\it's $x `y\\ctx.md";
  type Hooks = Record<string, (...args: unknown[]) => Promise<void>>;
  const options = (dir: string, sandbox: string | null = null): OpencodePluginOptions => ({
    projectRoot: dir,
    sessionsDir: path.join(dir, "sessions"),
    renameDir: path.join(dir, "rename"),
    sandbox
  });

  /** Compiles the plugin; the fake client records renames and answers each with `answer` (the
   *  SDK's `{ error }` for a session its process does not hold). */
  async function load(dir: string, sandbox: string | null = null, answer?: unknown): Promise<{ hooks: Hooks; renames: unknown[] }> {
    const source = renderOpencodePlugin(options(dir, sandbox));
    const compiled = path.join(dir, "tet.js");
    fs.writeFileSync(compiled, esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code);
    const renames: unknown[] = [];
    const client = {
      session: {
        update: async (request: unknown) => {
          renames.push(request);
          return answer;
        }
      }
    };
    const module = createRequire(__filename)(compiled) as { TETPlugin: (input: unknown) => Promise<Hooks> };
    return { hooks: await module.TETPlugin({ client, directory: dir }), renames };
  }

  const session = (id: string, extra: Record<string, unknown> = {}): unknown => ({
    type: "session.created",
    properties: { info: { id, title: "First prompt", time: { created: 1, updated: 2 }, ...extra } }
  });

  it("compiles as TypeScript whatever the paths hold", () => {
    const source = renderOpencodePlugin(options(nasty));
    assert.doesNotThrow(() => esbuild.transformSync(source, { loader: "ts" }));
    assert.ok(source.includes(JSON.stringify(nasty)), "baked in as a JS literal, never spliced raw");
  });

  it("does nothing for another repository's process", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-oc-plugin-"));
    process.env.TET_PROJECT_ROOT = "elsewhere";
    const channel = await controlChannel();
    try {
      const { hooks } = await load(dir);
      await hooks.event({ event: session("ses_a") });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(fs.existsSync(path.join(dir, "sessions", "ses_a.json")), false);
      assert.deepEqual(channel.reports, []);
      // The plugins dir is shared across repositories: another one's prompt would be doubled.
      const request = { system: ["opencode's own"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "ses_a" }, request);
      assert.deepEqual(request.system, ["opencode's own"]);
    } finally {
      await channel.close();
    }
  });

  it("records root sessions, reports the turns, and appends TET's system prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-oc-plugin-"));
    process.env.TET_PROJECT_ROOT = dir;
    const channel = await controlChannel();
    try {
      const { hooks } = await load(dir, "tet-opencode-abc");

      await hooks.event({ event: session("ses_a") });
      await hooks.event({ event: session("ses_child", { parentID: "ses_a" }) });
      const record = JSON.parse(fs.readFileSync(path.join(dir, "sessions", "ses_a.json"), "utf8"));
      assert.deepEqual(record, { id: "ses_a", title: "First prompt", created: 1, updated: 2, sandbox: "tet-opencode-abc" });
      assert.equal(fs.existsSync(path.join(dir, "sessions", "ses_child.json")), false, "a subagent's session is no tab");
      await hooks.event({ event: { ...(session("ses_a", { title: "Named" }) as object), type: "session.updated" } });
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "sessions", "ses_a.json"), "utf8")).title, "Named");

      // chat.message is the turn's one start, and adds nothing to the message.
      const output = { message: { id: "msg_1", sessionID: "ses_a" }, parts: [] as unknown[] };
      await hooks["chat.message"]({}, output);
      assert.equal(output.parts.length, 0);
      await hooks["chat.message"]({}, { message: { id: "msg_2", sessionID: "ses_child" }, parts: [] });
      const request = { system: ["opencode's own"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "ses_a" }, request);
      assert.deepEqual(request.system, ["opencode's own", TET_SYSTEM_PROMPT]);

      // Raised on every step of a turn, so not reported: each would be a round trip, the last
      // racing the idle below.
      await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } });
      await hooks.event({ event: { type: "question.asked", properties: { sessionID: "ses_a" } } });
      // A subagent's turns are not the tab's.
      await eventually("the root session's three", () => channel.reports.length === 3, 3000);
      assert.deepEqual(reported(channel.reports), ["prompt-submit", "stop", "permission"]);
      assert.deepEqual(
        channel.reports.map((report) => hookSessionId(String(report.args.payload))),
        ["ses_a", "ses_a", "ses_a"],
        "each report names the root session, which binds the tab to it"
      );

      await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_a" } } } });
      assert.equal(fs.existsSync(path.join(dir, "sessions", "ses_a.json")), false);
    } finally {
      await channel.close();
    }
  });

  it("holds a permission back until opencode had its chance to approve it itself", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-oc-plugin-"));
    process.env.TET_PROJECT_ROOT = dir;
    const channel = await controlChannel();
    try {
      const { hooks } = await load(dir);
      await hooks.event({ event: { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_a" } } });
      await hooks.event({ event: { type: "permission.replied", properties: { requestID: "per_1", sessionID: "ses_a" } } });
      await hooks.event({ event: { type: "permission.asked", properties: { id: "per_2", sessionID: "ses_b" } } });
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.deepEqual(reported(channel.reports), ["permission"], "the auto-approved one never counted as a question");

      // The slow one stood as a question, so its reply must clear the mark — nothing else would
      // before the turn ends.
      await hooks.event({ event: { type: "permission.replied", properties: { requestID: "per_2", sessionID: "ses_b" } } });
      await eventually("the question taken back", () => channel.reports.length === 2, 3000);
      assert.deepEqual(reported(channel.reports), ["permission", "prompt-submit"]);
      await hooks.event({ event: { type: "permission.replied", properties: { requestID: "per_2", sessionID: "ses_b" } } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(channel.reports.length, 2, "and only once, however often the reply is seen");
    } finally {
      await channel.close();
    }
  });

  it("applies a rename request through the session's own process", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-oc-plugin-"));
    process.env.TET_PROJECT_ROOT = dir;
    const { renames } = await load(dir);
    fs.mkdirSync(path.join(dir, "rename"), { recursive: true });
    fs.writeFileSync(path.join(dir, "rename", "ses_a"), "New title\n");
    fs.writeFileSync(path.join(dir, "rename", "..escape"), "nope");
    await eventually("the request is picked up", () => renames.length === 1, 3000);
    assert.deepEqual(renames, [{ path: { id: "ses_a" }, body: { title: "New title" } }]);
    assert.equal(fs.existsSync(path.join(dir, "rename", "ses_a")), false, "consumed");
  });

  it("leaves a rename request its own database has no session for", async () => {
    // A host and a sandboxed tab of one repository poll the same folder, each holding only its own
    // sessions: neither may drop the other's request.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-oc-plugin-"));
    process.env.TET_PROJECT_ROOT = dir;
    const { renames } = await load(dir, "tet-opencode-abc", { error: { name: "NotFoundError" } });
    fs.mkdirSync(path.join(dir, "rename"), { recursive: true });
    fs.writeFileSync(path.join(dir, "rename", "ses_b"), "Other title\n");
    await eventually("the request is tried", () => renames.length >= 1, 3000);
    assert.equal(fs.existsSync(path.join(dir, "rename", "ses_b")), true, "left for the process whose session it is");
  });
});

describe("the color themes", () => {
  const dir = path.join(__dirname, "..", "src", "renderer", "themes");
  const sheets = new Map(THEMES.map((theme) => [theme.id, fs.readFileSync(path.join(dir, `${theme.id}.css`), "utf8")]));
  const declared = (css: string): string[] => [...css.matchAll(/^\s+(color-scheme|--vscode-[\w-]+):/gm)].map((m) => m[1]);
  const valueOf = (css: string, name: string): string | undefined => css.match(new RegExp(`${name}:([^;]+);`))?.[1].trim();

  it("has one stylesheet per entry in THEMES, and none besides", () => {
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".css")).sort();
    assert.deepEqual(files, THEMES.map((theme) => `${theme.id}.css`).sort());
    for (const [id, css] of sheets) {
      assert.ok(css.includes(`:root[data-theme="${id}"]`), `${id}.css declares its own block`);
    }
  });

  // A variable forgotten in one stylesheet would show a value falling through from another theme.
  it("declares the complete variable list in every stylesheet, each variable once", () => {
    const [reference, ...others] = [...sheets];
    const expected = declared(reference[1]).sort();
    assert.equal(new Set(expected).size, expected.length, `${reference[0]}.css declares nothing twice`);
    for (const [id, css] of others) {
      const names = declared(css);
      assert.equal(new Set(names).size, names.length, `${id}.css declares nothing twice`);
      assert.deepEqual(names.sort(), expected, `${id}.css against ${reference[0]}.css`);
    }
  });

  // Hand-kept copies of four stylesheet values, for code that needs them outside the renderer's CSS.
  it("keeps each definition's window and terminal colors in step with its stylesheet", () => {
    for (const theme of THEMES) {
      const css = sheets.get(theme.id)!;
      assert.equal(valueOf(css, "--vscode-titleBar-activeBackground"), theme.windowBackground, theme.id);
      assert.equal(valueOf(css, "--vscode-titleBar-activeForeground"), theme.titleBarSymbolColor, theme.id);
      assert.equal(valueOf(css, "--vscode-terminal-background"), theme.terminalBackground, theme.id);
      assert.equal(valueOf(css, "--vscode-terminal-foreground"), theme.terminalForeground, theme.id);
    }
  });
});

/** The net under an unhandled fault — see uncaught.ts for why the main process survives one. */
describe("an uncaught exception", () => {
  it("logs the whole stack, tells the user once, and lets the process live", () => {
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tet-uncaught-")), "errors.log");
    const notices: string[] = [];
    const before = process.listenerCount("uncaughtException");
    installUncaughtHandler(logFile, (_severity, message) => notices.push(message));
    // Called directly, not via `process.emit`: node's test runner listens too and would count a crash.
    const handler = process.listeners("uncaughtException")[before];
    // The handler's stderr report would read like a crashed run; the log file is asserted on.
    const printed = console.error;
    console.error = () => undefined;
    try {
      const error = new Error("write EAGAIN");
      error.stack = "Error: write EAGAIN\n    at WriteWrap.onWriteComplete";
      handler(error, "uncaughtException");
      handler(error, "uncaughtException");
      const log = fs.readFileSync(logFile, "utf8");
      assert.ok(log.includes(`${UNCAUGHT_MARKER} (uncaughtException, #1)`), "marked, with its origin and count");
      assert.match(log, /#2/, "every occurrence is logged");
      assert.match(log, /at WriteWrap\.onWriteComplete/, "the stack, not just the message");
      assert.equal(notices.length, 1, "one notice per distinct error, however often it repeats");
      assert.match(notices[0], /write EAGAIN/);
    } finally {
      console.error = printed;
      process.off("uncaughtException", handler);
    }
  });
});
