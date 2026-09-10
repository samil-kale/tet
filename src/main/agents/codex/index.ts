import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_TARGET } from "../../terminals/hook-target";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { ThemeDefinition } from "../../../shared/themes";
import type { AgentDefinition } from "../agent";
import { setupCodexHooks } from "./hooks";
import { codexSessionProvider } from "./sessions";

/**
 * On win32 Codex reads its colors from the *console*, not the terminal:
 * `GetConsoleScreenBufferInfoEx` on the ConPTY between us, whose palette is conhost's Campbell
 * default whatever xterm draws. Codex blends its composer and user-message boxes from that, so
 * on a light theme they came out near-black on white (measured).
 *
 * What ConPTY does reflect in that table is OSC 4: set entry 0 (the default background's index)
 * and 7 (the foreground's) and Codex reads the theme's colors back (measured); OSC 10/11 change
 * nothing there. The sequence has to come from a process inside the pty, so a generated `.cmd`
 * prints it (`<nul set /p` — `echo` would add a line) and hands over to Codex with `%*`. ConPTY
 * forwards the OSC 4 to xterm too, which `terminal-views.ts` swallows.
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
  // `--ephemeral` skips the rollout file entirely, so there is nothing for cleanupAsk to remove.
  askArgs: ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never"],
  sessions: codexSessionProvider,
  prepareSpawn: (executable, _cwd, paths) => {
    let args: string[] = [];
    let launcher: string | undefined;
    if (process.platform === "win32") {
      try {
        launcher = writeConsoleColorLauncher(paths.agentDir, executable, paths.theme);
      } catch (error) {
        // Codex itself still starts without it, only drawing its boxes for a black console.
        console.error("[tet] could not write Codex's launcher:", error);
      }
    }
    try {
      args = setupCodexHooks();
    } catch (error) {
      // See prepareSpawn: swallow, never reject.
      console.error("[tet] could not set up Codex hooks:", error);
    }
    return Promise.resolve({ args, executable: launcher });
  },
  prepareSandboxSpawn: () => {
    try {
      return { args: setupCodexHooks(SANDBOX_TARGET) };
    } catch (error) {
      console.error("[tet] could not set up Codex sandbox hooks:", error);
      return { args: [] };
    }
  },
  // No documented readiness signal — a plain byte count. Observed on a real install: setup and
  // onboarding chunks total a few hundred bytes before the first real redraw, itself a single
  // ~700-900 byte chunk. Unverified against a logged-in start, which may draw less — revisit.
  createIsSessionReady: () => createByteThresholdCheck(600),
  // One: a second byte would land mid-shutdown and kill it instead.
  quitPresses: 1
  // Measured through this pty at 0.153.4: Codex runs raw and reads \x03 as an ordinary byte — with
  // text in the composer it clears it and lives on, with an empty one it quits itself, printing
  // its own "Session ID:" line and exiting 0. It used to sit in cooked mode, where win32 turned
  // the byte into a process-level CTRL_C_EVENT that killed it, and tet swallowed Ctrl+C for it.
};
