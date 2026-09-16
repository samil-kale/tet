import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_TARGET } from "../../terminals/hook-target";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { ThemeDefinition } from "../../../shared/themes";
import type { AgentDefinition } from "../agent";
import { hookSessionId } from "../hook-payload";
import { setupCodexHooks } from "./hooks";
import { codexSessionProvider } from "./sessions";
import { TET_SYSTEM_PROMPT } from "../system-prompt";

/**
 * Codex's developer instructions for this process, as a TOML basic string: `-c` parses its value
 * as TOML, and a bare sentence only works through the fallback to a raw string. Measured through
 * launch.cmd too, where codex.exe's command line held it as one argument (see system-prompt.ts).
 * It replaces a `developer_instructions` of the user's own config.toml for this process.
 */
const SYSTEM_PROMPT_ARGS = ["-c", `developer_instructions="${TET_SYSTEM_PROMPT}"`];

/**
 * On win32 Codex reads its colors from the *console* (`GetConsoleScreenBufferInfoEx` on ConPTY,
 * conhost's Campbell palette whatever xterm draws) and blends its composer and message boxes from
 * it — near-black on a light theme (measured).
 *
 * ConPTY reflects OSC 4 in that table: set entries 0 (background) and 7 (foreground) and Codex
 * reads the theme's colors (measured); OSC 10/11 do not. It must come from inside the pty, so a
 * generated `.cmd` prints it (`<nul set /p`; `echo` adds a line) and runs Codex with `%*`. The
 * OSC 4 also reaches xterm, where `terminal-views.ts` swallows it.
 */
function writeConsoleColorLauncher(agentDir: string, executable: string, theme: ThemeDefinition): string {
  const rgb = (hex: string): string => `rgb:${hex.slice(1, 3)}/${hex.slice(3, 5)}/${hex.slice(5, 7)}`;
  const osc4 = `\x1b]4;0;${rgb(theme.terminalBackground)}\x1b\\\x1b]4;7;${rgb(theme.terminalForeground)}\x1b\\`;
  const launcher = path.join(agentDir, "launch.cmd");
  fs.writeFileSync(launcher, `@echo off\r\n<nul set /p "=${osc4}"\r\n${executable} %*\r\n`, "utf8");
  return launcher;
}

export const codexAgent: AgentDefinition = {
  id: "codex",
  displayName: "Codex",
  executable: () => "codex",
  versionArgs: ["--version"],
  // `--ephemeral` writes no rollout, so no cleanupAsk.
  askArgs: ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never"],
  sessions: codexSessionProvider,
  sessionIdOf: hookSessionId,
  prepareSpawn: (executable, _cwd, paths) => {
    let args: string[] = [];
    let launcher: string | undefined;
    if (process.platform === "win32") {
      try {
        launcher = writeConsoleColorLauncher(paths.agentDir, executable, paths.theme);
      } catch (error) {
        // Codex still starts, drawing its boxes for a black console.
        console.error("[tet] could not write Codex's launcher:", error);
      }
    }
    try {
      args = setupCodexHooks();
    } catch (error) {
      // See prepareSpawn: swallow, never reject.
      console.error("[tet] could not set up Codex hooks:", error);
    }
    return Promise.resolve({ args: [...args, ...SYSTEM_PROMPT_ARGS], executable: launcher });
  },
  prepareSandboxSpawn: () => {
    try {
      return { args: [...setupCodexHooks(SANDBOX_TARGET), ...SYSTEM_PROMPT_ARGS] };
    } catch (error) {
      console.error("[tet] could not set up Codex sandbox hooks:", error);
      return { args: SYSTEM_PROMPT_ARGS };
    }
  },
  // Observed: setup and onboarding total a few hundred bytes before the first real redraw, one
  // ~700-900 byte chunk. Unverified for a logged-in start, which may draw less.
  createIsSessionReady: () => createByteThresholdCheck(600),
  // See AgentDefinition.questionOutlivesTurn.
  questionOutlivesTurn: true,
  // A second byte would land mid-shutdown and kill it.
  quitPresses: 1
  // Measured at 0.153.4: Codex reads \x03 as a byte — it clears a non-empty composer, and quits
  // (exit 0) on an empty one.
  //
  // Codex reprints its whole scrollback on any real pty resize: it never enters its alternate
  // screen, and `alternate_screen = "always"` has no effect in the shipped binary (raw pty bytes
  // captured; openai/codex#24552). A Codex bug — per-agent resize suppression only trades one
  // symptom for another, so wait for an upstream fix.
};
