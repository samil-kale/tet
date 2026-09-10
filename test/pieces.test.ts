import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as esbuild from "esbuild";
import { hookTrustedHash, setupCodexHooks } from "../src/main/agents/codex/hooks";
import { renderOpencodePlugin, type OpencodePluginOptions } from "../src/main/agents/opencode/plugin";
import { renderPiExtension, writePiExtension } from "../src/main/agents/pi/extension";
import { createByteThresholdCheck, createNonAsciiThresholdCheck } from "../src/main/terminals/session-ready";
import { reportApplies, SIGNAL_STALE_MS } from "../src/main/terminals/turn-order";
import { HOST_TARGET, SANDBOX_TARGET, toContainerPath } from "../src/main/terminals/hook-target";
import { ensureNotifyScript, NOTIFY_ENV, shellSingleQuote } from "../src/main/terminals/os-notify";
import { ProjectStore } from "../src/main/projects";
import { contractHome, fixedMountSpecs, pathMountSpecs, sandboxName } from "../src/main/sbx";
import { resolveCommand } from "../src/main/terminals/pty";
import { SettingsStore } from "../src/main/settings";
import { installUncaughtHandler, UNCAUGHT_MARKER } from "../src/main/uncaught";
import { DEFAULT_PROMPTS, effectivePrompt } from "../src/shared/prompts";
import { THEMES } from "../src/shared/themes";
import { CONTROL_ENV } from "../src/shared/control";
import type { ControlRequest } from "../src/shared/control";
import { DEFAULT_KEYBINDING_PRESET_ID } from "../src/shared/types";
import { eventually } from "./helpers";

/** The small measured pieces: each was paid for once, and each is one edit away from silently wrong. */

describe("Codex's hook trust", () => {
  // What this implementation answered when it was verified against a real Codex install (see
  // hooks.ts): a change here is the "Hooks need review" screen coming back.
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
    assert.match(hooks, /^hooks=\{UserPromptSubmit=\[/);
    for (const event of ["Stop", "PermissionRequest", "PreToolUse"]) {
      assert.ok(hooks.includes(`${event}=[`), event);
    }
    assert.match(hooks, /matcher='request_user_input'/);
    const trusted = hooks.match(/trusted_hash='sha256:[0-9a-f]{64}'/g) ?? [];
    assert.equal(trusted.length, 4, "one per event, each its own handler");
    assert.ok(!args.some((arg) => arg.startsWith("hooks.")), "one value, never key paths");
  });

  it("registers one plain tet-ctl call per event, host and sandbox alike", () => {
    for (const target of [HOST_TARGET, SANDBOX_TARGET]) {
      const hooks = setupCodexHooks(target)[1];
      for (const event of ["prompt-submit", "stop", "permission", "question"]) {
        assert.ok(hooks.includes(`command='tet-ctl hook ${event}'`), `${event} on ${target.posix ? "posix" : "win32"}`);
      }
      // Nothing of the host's shows through into a sandbox's trust key, and nothing is written.
      assert.match(hooks, target.posix ? /'\/<session-flags>\/config\.toml:/ : /'C:\\<session-flags>\\config\.toml:/);
    }
  });
});

describe("resolveCommand", () => {
  it("spawns a native executable directly and routes a shim through cmd.exe", { skip: process.platform !== "win32" && "win32 only" }, () => {
    assert.deepEqual(resolveCommand("C:\\tools\\run.exe", ["-v"]), { command: "C:\\tools\\run.exe", args: ["-v"] });
    assert.deepEqual(resolveCommand("C:\\tools\\run.cmd", ["-v"]), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "C:\\tools\\run.cmd", "-v"]
    });
    assert.deepEqual(resolveCommand("C:\\Program Files\\run.cmd", ["-v"]).args, [
      "/d",
      "/s",
      "/c",
      "call",
      "C:\\Program Files\\run.cmd",
      "-v"
    ]);
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

  it("mounts tet's own dirs live — agentDir read-write, the context file's directory read-only", () => {
    const agentDir = path.join(os.tmpdir(), "agents", "claude", "p");
    const contextDir = path.join(os.tmpdir(), "ctx");
    assert.deepEqual(fixedMountSpecs({ agentDir, contextFile: path.join(contextDir, "context.md") }), [
      agentDir,
      pathMountSpecs({ path: contextDir, access: "ro" }).mount
    ]);
  });
});

describe("the quoting helpers", () => {
  it("make any value one literal word in their shell", () => {
    assert.equal(shellSingleQuote("it's $HOME"), `'it'\\''s $HOME'`);
  });
});

describe("the notification script", () => {
  it("takes its text from the environment, and is written once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-notify-"));
    const first = ensureNotifyScript(dir);
    const file = first.args[first.args.length - 1];
    const written = fs.readFileSync(file, "utf8");
    // One file for every toast is only safe while no toast's own text goes into it: a second
    // notification rewriting the script fails outright where the first still has it open.
    assert.ok(written.includes(NOTIFY_ENV.title), "reads the title from the environment");
    assert.ok(written.includes(NOTIFY_ENV.body), "reads the body from the environment");
    const writtenAt = fs.statSync(file).mtimeMs;
    assert.deepEqual(ensureNotifyScript(dir), first);
    assert.equal(fs.statSync(file).mtimeMs, writtenAt, "unchanged content is not written again");
    assert.deepEqual(fs.readdirSync(dir), [path.basename(file)], "nothing left beside it");
  });
});

describe("the stores", () => {
  it("read a hand-edited settings file field by field", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-settings-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{ nope");
    assert.equal(new SettingsStore(dir).get().theme, "system");
    fs.writeFileSync(
      file,
      JSON.stringify({
        notifications: { finished: false, needsYou: "yes" },
        theme: "solarized",
        editorKeybindingPreset: "",
        prompts: { commitMessage: DEFAULT_PROMPTS.commitMessage, commands: "removed setting" }
      })
    );
    const settings = new SettingsStore(dir).get();
    assert.deepEqual(settings.notifications, { finished: false, needsYou: true, idleReminder: false });
    assert.equal(settings.theme, "solarized", "an unknown id is left standing for the readers to fall back from");
    assert.equal(settings.editorKeybindingPreset, DEFAULT_KEYBINDING_PRESET_ID);
    assert.deepEqual(settings.prompts, { commitMessage: "" }, "tet's own text spelled out is stored as none");
    assert.equal(effectivePrompt(settings.prompts, "commitMessage"), DEFAULT_PROMPTS.commitMessage);
    assert.equal(effectivePrompt({ commitMessage: "write a subject" }, "commitMessage"), "write a subject");
    const store = new SettingsStore(dir);
    store.save({ ...settings, theme: "light-modern" });
    assert.equal(new SettingsStore(dir).get().theme, "light-modern", "written whole and read back");
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
    // opencode's blank full-screen repaint while it waits on its model list: all ASCII —
    // escape codes and spaces — however many bytes of it arrive.
    assert.equal(ready("\x1b[38;2;255;255;255m\x1b[H" + " ".repeat(4800)), false);
    assert.equal(ready("\x1b[38;2;255;255;255m\x1b[H" + " ".repeat(4800)), false);
    // The frame that actually has something on it: two box-drawing characters clear the
    // threshold, one does not.
    assert.equal(ready("▄"), false);
    assert.equal(ready("▄"), true);
  });
});

/**
 * A stand-in for the control server plus the environment a tab's process carries: what a
 * generated plugin or extension reports lands here. They report fire-and-forget, so a test waits
 * for what it expects rather than awaiting the call itself.
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

/** The events reported so far, in order. */
function reported(reports: ControlRequest[]): string[] {
  return reports.map((report) => String(report.args.event));
}

describe("which of two turn reports counts", () => {
  // The direction of this comparison is what a finished turn going back to working hangs on.
  it("drops the one that lost the race, and takes one whose clock jumped backwards", () => {
    const now = Date.now();
    assert.equal(reportApplies(undefined, now), true, "nothing has been applied here yet");
    assert.equal(reportApplies(now, now), true, "the same moment still counts");
    assert.equal(reportApplies(now, now + 5), true, "newer than the last one");
    assert.equal(reportApplies(now, now - 200), false, "still in flight when the newer one landed");
    assert.equal(reportApplies(now, now - SIGNAL_STALE_MS - 1), true, "a clock that moved, not a race");
  });
});

describe("pi's extension", () => {
  // Every path tet generates has the user's own name in it, and any of these characters could be
  // in that; pi exits outright on an extension that does not compile.
  const nasty = "C:\\Users\\it's $x `y\\ctx.md";

  it("compiles as TypeScript whatever the paths hold", () => {
    const source = renderPiExtension({ contextFile: nasty });
    assert.doesNotThrow(() => esbuild.transformSync(source, { loader: "ts" }));
    assert.ok(source.includes(JSON.stringify(nasty)), "baked in as a JS literal, never spliced raw");
  });

  it("reports both ends of a turn and a question, and appends the context file to the prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-pi-ext-"));
    const contextFile = path.join(dir, "context.md");
    const channel = await controlChannel();
    try {
      const source = renderPiExtension({ contextFile });
      const compiled = path.join(dir, "tet.js");
      fs.writeFileSync(compiled, esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code);
      const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
      (createRequire(__filename)(compiled) as { default: (pi: unknown) => void }).default({
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers[event] = handler;
        }
      });

      fs.writeFileSync(contextFile, "﻿hello\n");
      assert.deepEqual(handlers.before_agent_start({ systemPrompt: "base" }, {}), { systemPrompt: "base\n\nhello" });
      fs.writeFileSync(contextFile, "  \n");
      assert.equal(handlers.before_agent_start({ systemPrompt: "base" }, {}), undefined, "blank means nothing to say");

      handlers.agent_start({}, {});
      handlers.agent_settled({}, {});
      handlers.ui_prompt_start({}, {});
      await eventually("all three reported", () => channel.reports.length === 3, 3000);
      assert.deepEqual(reported(channel.reports), ["prompt-submit", "stop", "permission"]);
      // The tab is the address; no session id is involved at all any more.
      assert.deepEqual(channel.reports[0].caller, { projectId: "p1", tabId: "tab-1" });
      assert.equal(channel.reports[0].verb, "hook");
      // Nothing here is awaited, so two reports of one turn race — each carries its own time,
      // which is what tet orders them by.
      assert.ok(
        channel.reports.every((report) => typeof report.at === "number" && report.at > 0),
        "every report says when it was made"
      );
    } finally {
      await channel.close();
    }
  });

  // The file is written on the host and read inside the container: every path in it is the
  // sandbox's own, and there is nothing else in there to translate.
  it("writes a sandbox one with container paths and nothing beside it", () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-pi-sbx-"));
    const contextFile = path.join(storageDir, "context.md");
    const file = writePiExtension(storageDir, contextFile, SANDBOX_TARGET);
    const source = fs.readFileSync(file, "utf8");

    assert.ok(source.includes(JSON.stringify(toContainerPath(contextFile))), "the context file as the container sees it");
    assert.deepEqual(fs.readdirSync(storageDir), ["tet.ts"], "no notify script, no marker directories");
    assert.ok(source.includes(JSON.stringify(CONTROL_ENV)), "the channel is read from the environment, not baked in");
  });
});

describe("opencode's plugin", () => {
  const nasty = "C:\\Users\\it's $x `y\\ctx.md";
  type Hooks = Record<string, (...args: unknown[]) => Promise<void>>;
  const options = (dir: string, sandbox: string | null = null): OpencodePluginOptions => ({
    projectRoot: dir,
    contextFile: path.join(dir, "context.md"),
    sessionsDir: path.join(dir, "sessions"),
    renameDir: path.join(dir, "rename"),
    sandbox
  });

  /** Compiles the plugin and returns its hooks, with a fake client that records renames. */
  async function load(dir: string, sandbox: string | null = null): Promise<{ hooks: Hooks; renames: unknown[] }> {
    const source = renderOpencodePlugin(options(dir, sandbox));
    const compiled = path.join(dir, "tet.js");
    fs.writeFileSync(compiled, esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code);
    const renames: unknown[] = [];
    const client = { session: { update: async (request: unknown) => void renames.push(request) } };
    const module = createRequire(__filename)(compiled) as { TETPlugin: (input: unknown) => Promise<Hooks> };
    return { hooks: await module.TETPlugin({ client, directory: dir }), renames };
  }

  const session = (id: string, extra: Record<string, unknown> = {}): unknown => ({
    type: "session.created",
    properties: { info: { id, title: "First prompt", time: { created: 1, updated: 2 }, ...extra } }
  });

  it("compiles as TypeScript whatever the paths hold", () => {
    const source = renderOpencodePlugin({ ...options(nasty), contextFile: nasty });
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
    } finally {
      await channel.close();
    }
  });

  it("records root sessions, reports the turns, and appends the context file", async () => {
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

      // The prompt being composed is the turn's one start, and the same call takes the context in.
      fs.writeFileSync(path.join(dir, "context.md"), "\uFEFFhello\n");
      const output = { message: { id: "msg_1", sessionID: "ses_a" }, parts: [] as { text: string; synthetic: boolean }[] };
      await hooks["chat.message"]({}, output);
      assert.equal(output.parts.length, 1);
      assert.equal(output.parts[0].text, "hello\n");
      assert.equal(output.parts[0].synthetic, true);
      await hooks["chat.message"]({}, { message: { id: "msg_2", sessionID: "ses_child" }, parts: [] });

      // Every step of the turn raises this, and reporting each was twenty round trips for one
      // turn \u2014 the last of them racing the idle below.
      await hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } });
      await hooks.event({ event: { type: "question.asked", properties: { sessionID: "ses_a" } } });
      // A subagent's own turns are none of the tab's business, and neither is anything that is
      // not a session id at all.
      await eventually("the root session's three", () => channel.reports.length === 3, 3000);
      assert.deepEqual(reported(channel.reports), ["prompt-submit", "stop", "permission"]);

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

      // The slow one did stand as a question, so its answer has to take the mark away again —
      // nothing else would before the turn ended.
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

  // Nothing falls through from another theme: a variable added to one stylesheet and forgotten
  // in another would otherwise show that other theme a value nobody chose for it.
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

  // The definition's copies of four stylesheet values, for the two processes that need them
  // before or outside the renderer's CSS — kept by hand, so checked here.
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

/**
 * The net under a fault nobody handled — see uncaught.ts for why the main process survives one
 * instead of letting Electron freeze every terminal behind a modal dialog. Driven by emitting
 * the event the way node would, since the point is the handler, not how the throw got there.
 */
describe("an uncaught exception", () => {
  it("logs the whole stack, tells the user once, and lets the process live", () => {
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tet-uncaught-")), "errors.log");
    const notices: string[] = [];
    const before = process.listenerCount("uncaughtException");
    installUncaughtHandler(logFile, (_severity, message) => notices.push(message));
    // The listener it registered, called the way node would call it — not `process.emit`, which
    // node's own test runner also listens for and would count as this test having crashed.
    const handler = process.listeners("uncaughtException")[before];
    // The handler prints its report to stderr as well, which here would read like this run
    // having crashed. Held back for the two calls below; the log file is what is asserted on.
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
