import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { hookTrustedHash, setupCodexHooks } from "../src/main/agents/codex/hooks";
import { watchMarkers } from "../src/main/terminals/marker-watch";
import { powershellSingleQuote, shellSingleQuote } from "../src/main/terminals/os-notify";
import { ProjectStore } from "../src/main/projects";
import { resolveCommand } from "../src/main/terminals/pty";
import { SettingsStore } from "../src/main/settings";
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
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-codex-hooks-"));
    const args = setupCodexHooks(storageDir, "Codex", { finished: true, needsYou: true, idleReminder: false }, "repo", path.join(storageDir, "context.md"));
    const hooks = args[args.indexOf("-c") + 1];
    assert.match(hooks, /^hooks=\{UserPromptSubmit=\[/);
    for (const event of ["Stop", "PermissionRequest", "PreToolUse"]) {
      assert.ok(hooks.includes(`${event}=[`), event);
    }
    assert.match(hooks, /matcher='request_user_input'/);
    const trusted = hooks.match(/trusted_hash='sha256:[0-9a-f]{64}'/g) ?? [];
    assert.equal(trusted.length, 5, "two on UserPromptSubmit, one on each of the other three");
    assert.match(hooks, /:user_prompt_submit:0:1'=\{trusted_hash=/, "the second handler is trusted on its own");
    assert.ok(!args.some((arg) => arg.startsWith("hooks.")), "one value, never key paths");
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

describe("the quoting helpers", () => {
  it("make any value one literal word in their shell", () => {
    assert.equal(shellSingleQuote("it's $HOME"), `'it'\\''s $HOME'`);
    assert.equal(powershellSingleQuote("it's $env:X"), `'it''s $env:X'`);
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
      JSON.stringify({ notifications: { finished: false, needsYou: "yes" }, theme: "solarized", themeAgents: { claude: false, codex: "x" }, editorKeybindingPreset: "" })
    );
    const settings = new SettingsStore(dir).get();
    assert.deepEqual(settings.notifications, { finished: false, needsYou: true, idleReminder: false });
    assert.equal(settings.theme, "solarized", "an unknown id is left standing for the readers to fall back from");
    assert.deepEqual(settings.themeAgents, { claude: false, opencode: true, codex: true });
    assert.equal(settings.editorKeybindingPreset, DEFAULT_KEYBINDING_PRESET_ID);
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

describe("the marker watch", () => {
  it("drains what a previous run left unreported, and reports what arrives, watcher or not", async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-markers-"));
    const dir = path.join(storageDir, "finished");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "stale-1"), "");
    const seen: [string, number][] = [];
    const stop = watchMarkers(storageDir, "finished", (id, at) => void seen.push([id, at]));
    await eventually("the stale marker gone", () => !fs.existsSync(path.join(dir, "stale-1")));
    assert.deepEqual(seen, []);
    const before = Date.now() - 1000;
    fs.writeFileSync(path.join(dir, "abc-123"), "");
    await eventually("the new marker reported", () => seen.length === 1, 4000);
    assert.equal(seen[0][0], "abc-123");
    assert.ok(seen[0][1] >= before, "dated by its mtime");
    assert.ok(!fs.existsSync(path.join(dir, "abc-123")), "taken away once reported");
    stop();
  });
});
