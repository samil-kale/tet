import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "./helpers";

/** eslint.config.mjs: the layers, the process borders and the rules AGENTS.md states, each held by
 *  one import or call it lets through and one it refuses. */

type Rule =
  | "no-restricted-imports"
  | "@typescript-eslint/no-restricted-imports"
  | "no-restricted-syntax"
  | "no-restricted-properties"
  | "no-restricted-globals";

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
  ["src/renderer/git/x.ts", 'import "../lanes/files/explorer-tree";', "no-restricted-imports"],
  ["src/renderer/lanes/files/x.ts", 'import "../../git/run-action";', null],
  ["src/renderer/lanes/files/x.ts", 'import "./explorer-tree";', null],
  // A lane imports no other lane, whichever way it is reached.
  ["src/renderer/lanes/files/x.ts", 'import "../projects/ProjectList";', "no-restricted-imports"],
  ["src/renderer/lanes/git/x.ts", 'import "../../lanes/files/explorer-tree";', "no-restricted-imports"],
  ["src/renderer/dialogs/x.ts", 'import "../lanes/projects/ProjectList";', "no-restricted-imports"],
  ["src/renderer/platform.ts", 'import "./App";', "no-restricted-imports"],
  ["src/renderer/lanes/files/x.ts", 'import "../../../renderer/git/run-action";', null],
  ["src/renderer/ui/x.ts", 'import "../../renderer/git/run-action";', "no-restricted-imports"],
  // The process borders.
  ["src/main/ipc/x.ts", 'import "../../shared/control";', null],
  ["src/main/ipc/x.ts", 'import "../../renderer/App";', "no-restricted-imports"],
  ["src/renderer/App.tsx", 'import "../main/main";', "no-restricted-imports"],
  ["src/preload/x.ts", 'import "../main/main";', "no-restricted-imports"],
  // Code running outside electron's main process.
  ["src/main/git/git.ts", 'import "../util/linked-git-dir";', null],
  ["src/main/git/git.ts", 'import "../util/process";', "no-restricted-imports"],
  ["src/main/git/explorer-host.ts", 'import "../util/utility-host";', null],
  ["src/main/git/explorer-read.ts", 'import "electron";', "no-restricted-imports"],
  ["src/shared/x.ts", 'import "electron";', "no-restricted-imports"],
  ["src/shared/types/x.ts", 'import "../errors";', null],
  ["src/shared/types/x.ts", 'import "../../main/main";', "no-restricted-imports"],
  // The renderer runs without node.
  ["src/renderer/ui/x.ts", 'import "node:fs";', "no-restricted-imports"],
  ["src/renderer/ui/x.ts", 'import "fs/promises";', "no-restricted-imports"],
  ["src/renderer/ui/x.ts", 'import "./paths";', null],
  // Every spawn from a listed spawn site, none through a shell.
  ["src/main/ipc/x.ts", 'import { exec } from "node:child_process";', "@typescript-eslint/no-restricted-imports"],
  ["src/main/util/process.ts", 'import { execSync } from "child_process";', "@typescript-eslint/no-restricted-imports"],
  ["src/main/ipc/x.ts", 'import { spawn } from "node:child_process";', "@typescript-eslint/no-restricted-imports"],
  ["src/main/ipc/x.ts", 'import * as childProcess from "node:child_process";', "@typescript-eslint/no-restricted-imports"],
  ["src/main/util/process.ts", 'import { execFile, spawn } from "node:child_process";', null],
  ["src/main/sbx/x.ts", 'import type { ChildProcess } from "node:child_process";', null],
  ["src/main/ipc/x.ts", 'import * as pty from "node-pty";', "@typescript-eslint/no-restricted-imports"],
  ["src/main/terminals/pty.ts", 'import * as pty from "node-pty";', null],
  ["src/main/terminals/x.ts", 'import type { IPty } from "node-pty";', null]
];

const CALLS: Probe[] = [
  // IPC only through the typed wrappers.
  ["src/main/ipc/x.ts", 'import { ipcMain } from "electron";\nipcMain.handle("a", () => 1);', "no-restricted-syntax"],
  ["src/main/ipc/channels.ts", 'import { ipcMain } from "electron";\nipcMain.handle("a", () => 1);', null],
  ["src/main/projects.ts", 'import type { BrowserWindow } from "electron";\ndeclare const w: BrowserWindow;\nw.webContents.send("x");', "no-restricted-syntax"],
  ["src/main/window.ts", 'import type { BrowserWindow } from "electron";\ndeclare const w: BrowserWindow;\nw.webContents.send("x");', null],
  // Every spawn through resolveCommand.
  ["src/main/x/x.ts", 'import { spawn } from "node:child_process";\nspawn("a", [], { shell: true });', "no-restricted-syntax"],
  ["src/preload/x.ts", 'export const api = { shell: { open: () => 1 } };', null],
  // The platform asked in two places only.
  ["src/main/util/x.ts", "export const p = process.platform;", "no-restricted-properties"],
  ["src/main/util/host-platform.ts", "export const p = process.platform;", null],
  ["src/renderer/ui/x.ts", "export const p = navigator.platform;", "no-restricted-properties"],
  ["test/main/x.test.ts", "export const p = process.platform;", "no-restricted-properties"],
  // The platform's id is data, compared only where the Platform is picked and by the installer's test.
  ["src/main/util/x.ts", 'export const a = (id: string) => id === "win32";', "no-restricted-syntax"],
  ["src/main/util/x.ts", 'export const a = (id: string) => { switch (id) { case "darwin": return 1; } return 0; };', "no-restricted-syntax"],
  ["src/shared/platform.ts", 'export const a = (id: string) => id === "win32";', null],
  ["src/renderer/platform.ts", 'export const a = "win32";', null],
  ["test/main/x.test.ts", 'export const a = (id: string) => "linux" !== id;', "no-restricted-syntax"],
  ["test/e2e/install.test.ts", 'export const a = (id: string) => id === "linux";', null],
  // No code outside agents/ names an agent but the shell; user-facing text may.
  ["src/main/ipc/x.ts", 'export const a = (id: string) => id === "claude";', "no-restricted-syntax"],
  ["src/renderer/ui/x.ts", 'export const a = (id: string) => { switch (id) { case "codex": return 1; } return 0; };', "no-restricted-syntax"],
  ["src/main/ipc/x.ts", 'export const a = (id: string) => id === "shell";', null],
  ["src/main/ipc/x.ts", 'export const a = "Ask Claude Code or Codex";', null],
  ["src/main/agents/x.ts", 'export const a = (id: string) => id === "pi";', null],
  // No native message boxes.
  ["src/main/ipc/x.ts", 'import { dialog } from "electron";\nvoid dialog.showMessageBox({ message: "x" });', "no-restricted-properties"],
  ["src/renderer/ui/x.ts", 'export const a = window.confirm("x");', "no-restricted-properties"],
  ["src/renderer/ui/x.ts", 'export const a = confirm("x");', "no-restricted-globals"],
  ["src/renderer/ui/x.ts", 'import { confirm } from "./Dialog";\nexport const a = confirm;', null],
  // HTTP through Chromium's stack.
  ["src/main/update/x.ts", 'void fetch("https://example.com");', "no-restricted-globals"],
  ["src/main/update/x.ts", 'import { net } from "electron";\nvoid net.fetch("https://example.com");', null],
  ["src/main/update/x.ts", 'import { net } from "electron";\nvoid net.fetch("https://example.com", { redirect: "manual" });', "no-restricted-syntax"],
  ["src/main/update/x.ts", 'import { net } from "electron";\nvoid net.fetch("https://example.com", { redirect: "follow" });', null],
  // Colors only from the themes.
  ["src/renderer/ui/x.ts", 'export const a = "#1e1e1e";', "no-restricted-syntax"],
  ["src/renderer/ui/x.tsx", 'export const a = <div style={{ color: "rgba(0, 0, 0, 0.4)" }} />;', "no-restricted-syntax"],
  ["src/renderer/ui/x.ts", "const n = 1;\nexport const a = `hsl(${n} 0% 0%)`;", "no-restricted-syntax"],
  ["src/renderer/ui/x.ts", 'export const a = "var(--vscode-focusBorder)";', null],
  ["src/renderer/themes/x.ts", 'export const a = "#1e1e1e";', null]
];

const RESTRICTING = [
  "no-restricted-imports",
  "@typescript-eslint/no-restricted-imports",
  "no-restricted-syntax",
  "no-restricted-properties",
  "no-restricted-globals"
];

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

/** A color in a stylesheet: hex, rgb(a) or hsl(a). */
const CSS_COLOR = /#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(rgba?|hsla?)\(/;
/** The dialog overlay's fixed dim, the one color no theme sets. */
const OVERLAY_DIM = { selector: ".dialog-overlay", declaration: "background: rgb(0 0 0 / 40%)" };

/** The renderer's stylesheets but the themes, which ESLint does not read. */
function stylesheets(): { file: string; css: string }[] {
  const renderer = path.join(ROOT, "src", "renderer");
  return fs
    .readdirSync(renderer, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".css") && !file.startsWith(`themes${path.sep}`))
    .map((file) => ({ file, css: fs.readFileSync(path.join(renderer, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));
}

describe("the renderer's stylesheets", () => {
  it("take their colors from the themes' variables, but the dialog overlay's dim", () => {
    for (const { file, css } of stylesheets()) {
      for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        for (const declaration of body.split(";").map((part) => part.trim())) {
          const dim = selector.trim() === OVERLAY_DIM.selector && declaration === OVERLAY_DIM.declaration;
          assert.ok(dim || !CSS_COLOR.test(declaration), `${file}: ${selector.trim()} { ${declaration} } names a color`);
        }
      }
    }
  });

  it("use a --tet-* variable only with its --vscode-* fallback", () => {
    for (const { file, css } of stylesheets()) {
      for (const [use, fallback] of css.matchAll(/var\(--tet-[\w-]+(,\s*var\(--vscode-)?/g)) {
        assert.ok(fallback, `${file}: ${use} has no --vscode-* fallback`);
      }
    }
  });
});
