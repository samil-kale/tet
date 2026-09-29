import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "./helpers";

/** eslint.config.mjs: the layers, the process borders and the rules AGENTS.md states, each held by
 *  one import or call it lets through and one it refuses. */

type Rule = "no-restricted-imports" | "no-restricted-syntax" | "no-restricted-properties" | "no-restricted-globals";

/** A file as it would lie in src/, what it holds, and the rule refusing it (null: none may). */
type Probe = [file: string, code: string, refusedBy: Rule | null];

const IMPORTS: Probe[] = [
  // src/main's layers.
  ["src/main/util/x.ts", 'import "./process";', null],
  ["src/main/util/x.ts", 'import "../store/settings";', "no-restricted-imports"],
  ["src/main/store/x.ts", 'import "../util/process";', null],
  ["src/main/store/x.ts", 'import "../git/git-client";', "no-restricted-imports"],
  ["src/main/sbx/x.ts", 'import "../agents";', null],
  ["src/main/git/x.ts", 'import "../agents";', "no-restricted-imports"],
  ["src/main/agents/claude/x.ts", 'import "../../terminals/pty";', "no-restricted-imports"],
  ["src/main/control/x.ts", 'import "../terminals/pty";', null],
  ["src/main/terminals/x.ts", 'import "../control/control-verb";', "no-restricted-imports"],
  ["src/main/control/x.ts", 'import "../window";', "no-restricted-imports"],
  ["src/main/window.ts", 'import "./projects";', null],
  // A detour through the process's own folder reaches the same area.
  ["src/main/control/x.ts", 'import "../../main/terminals/pty";', null],
  ["src/main/terminals/x.ts", 'import "../../main/control/control-verb";', "no-restricted-imports"],
  ["src/main/util/x.ts", 'import "../../../src/main/store/settings";', "no-restricted-imports"],
  // An agent's own folder: from outside agents/, beside the registry, from another agent's.
  ["src/main/ipc/x.ts", 'import "../agents/agent-path";', null],
  ["src/main/ipc/x.ts", 'import "../agents/claude";', "no-restricted-imports"],
  ["src/main/ipc/x.ts", 'import "../../main/agents/claude";', "no-restricted-imports"],
  ["src/main/agents/index.ts", 'import "./claude";', null],
  ["src/main/agents/system-prompt.ts", 'import "./agent-path";', null],
  ["src/main/agents/system-prompt.ts", 'import "./claude/hooks";', "no-restricted-imports"],
  ["src/main/agents/claude/x.ts", 'import "./hooks";', null],
  ["src/main/agents/claude/x.ts", 'import "../transcript";', null],
  ["src/main/agents/claude/x.ts", 'import "../codex/cli";', "no-restricted-imports"],
  // src/renderer's layers.
  ["src/renderer/ui/x.ts", 'import "../platform";', null],
  ["src/renderer/ui/x.ts", 'import "../tabs/pane-layout";', "no-restricted-imports"],
  ["src/renderer/editor/x.ts", 'import "../tabs/terminal-views";', "no-restricted-imports"],
  ["src/renderer/tabs/links/x.ts", 'import "../../editor/editor-tab";', null],
  ["src/renderer/git/x.ts", 'import "../files/file-mark";', "no-restricted-imports"],
  ["src/renderer/files/x.ts", 'import "../git/run-action";', null],
  ["src/renderer/files/x.ts", 'import "../sidebar/ProjectList";', "no-restricted-imports"],
  ["src/renderer/platform.ts", 'import "./App";', "no-restricted-imports"],
  ["src/renderer/files/x.ts", 'import "../../renderer/git/run-action";', null],
  ["src/renderer/ui/x.ts", 'import "../../renderer/git/run-action";', "no-restricted-imports"],
  // The process borders.
  ["src/main/ipc/x.ts", 'import "../../shared/control";', null],
  ["src/main/ipc/x.ts", 'import "../../renderer/App";', "no-restricted-imports"],
  ["src/renderer/App.tsx", 'import "../main/main";', "no-restricted-imports"],
  ["src/preload/x.ts", 'import "../main/main";', "no-restricted-imports"],
  // Code running outside electron's main process.
  ["src/main/git/git.ts", 'import "../util/linked-git-dir";', null],
  ["src/main/git/git.ts", 'import "../util/process";', "no-restricted-imports"],
  ["src/shared/x.ts", 'import "electron";', "no-restricted-imports"],
  ["src/shared/types/x.ts", 'import "../errors";', null],
  ["src/shared/types/x.ts", 'import "../../main/main";', "no-restricted-imports"]
];

const CALLS: Probe[] = [
  // IPC only through the typed wrappers.
  ["src/main/ipc/x.ts", 'import { ipcMain } from "electron";\nipcMain.handle("a", () => 1);', "no-restricted-syntax"],
  ["src/main/ipc/channels.ts", 'import { ipcMain } from "electron";\nipcMain.handle("a", () => 1);', null],
  ["src/main/projects.ts", 'import type { BrowserWindow } from "electron";\ndeclare const w: BrowserWindow;\nw.webContents.send("x");', "no-restricted-syntax"],
  ["src/main/window.ts", 'import type { BrowserWindow } from "electron";\ndeclare const w: BrowserWindow;\nw.webContents.send("x");', null],
  // Every spawn through resolveCommand.
  ["src/main/x/x.ts", 'import { spawn } from "node:child_process";\nspawn("a", [], { shell: true });', "no-restricted-syntax"],
  // The platform asked in two places only.
  ["src/main/util/x.ts", "export const p = process.platform;", "no-restricted-properties"],
  ["src/main/util/host-platform.ts", "export const p = process.platform;", null],
  ["src/renderer/ui/x.ts", "export const p = navigator.platform;", "no-restricted-properties"],
  // No native message boxes.
  ["src/main/ipc/x.ts", 'import { dialog } from "electron";\nvoid dialog.showMessageBox({ message: "x" });', "no-restricted-properties"],
  ["src/renderer/ui/x.ts", 'export const a = window.confirm("x");', "no-restricted-properties"],
  ["src/renderer/ui/x.ts", 'export const a = confirm("x");', "no-restricted-globals"],
  ["src/renderer/ui/x.ts", 'import { confirm } from "./Dialog";\nexport const a = confirm;', null],
  // HTTP through Chromium's stack.
  ["src/main/update/x.ts", 'void fetch("https://example.com");', "no-restricted-globals"],
  ["src/main/update/x.ts", 'import { net } from "electron";\nvoid net.fetch("https://example.com");', null]
];

const RESTRICTING = ["no-restricted-imports", "no-restricted-syntax", "no-restricted-properties", "no-restricted-globals"];

/** Every probe's restricting rules, in one ESLint run: the config loads once. */
function lint(probes: Probe[]): string[][] {
  const script = `
    const { ESLint } = require(${JSON.stringify(path.join(ROOT, "node_modules", "eslint"))});
    const probes = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const eslint = new ESLint({ cwd: ${JSON.stringify(ROOT)} });
    (async () => {
      const out = [];
      for (const [file, code] of probes) {
        const [result] = await eslint.lintText(code, { filePath: require("node:path").join(${JSON.stringify(ROOT)}, file) });
        out.push(result.messages.map((message) => message.ruleId ?? message.message));
      }
      process.stdout.write(JSON.stringify(out));
    })();
  `;
  const run = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, input: JSON.stringify(probes), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return (JSON.parse(run.stdout) as string[][]).map((rules) => rules.filter((rule) => RESTRICTING.includes(rule)));
}

describe("the lint rules", () => {
  for (const [name, probes] of [
    ["hold the layers and the process borders", IMPORTS],
    ["hold the calls AGENTS.md rules out", CALLS]
  ] as const) {
    it(name, () => {
      const found = lint([...probes]);
      probes.forEach(([file, code, refusedBy], index) => {
        const what = `${file}: ${code}`;
        if (refusedBy === null) {
          assert.deepEqual(found[index], [], `${what} is let through`);
        } else {
          assert.ok(found[index].includes(refusedBy), `${what} is refused by ${refusedBy}, got [${found[index].join(", ")}]`);
        }
      });
    });
  }
});
