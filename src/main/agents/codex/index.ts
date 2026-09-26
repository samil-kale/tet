import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_HOME, SANDBOX_TARGET } from "../../terminals/hook-target";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import { writeIfChanged } from "../../write-if-changed";
import type { ThemeDefinition } from "../../../shared/themes";
import type { AgentDefinition } from "../agent";
import { hookSessionId } from "../hook-payload";
import { setupCodexHooks } from "./hooks";
import { codexHome, codexSessionProvider } from "./sessions";

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
  // Rename into place: a theme change rewrites it while a tab may be starting through it, and
  // cmd.exe reading it truncated runs nothing (measured under repeated rewrites).
  writeIfChanged(launcher, `@echo off\r\n<nul set /p "=${osc4}"\r\n${executable} %*\r\n`);
  return launcher;
}

/**
 * Codex's fullscreen transcript, always: only there does it enter the alternate screen (0.156.1,
 * raw pty bytes), so a resize redraws in place instead of reprinting the whole transcript into the
 * scrollback (openai/codex#24552); the plain TUI never does, `tui.alternate_screen = "always"`
 * included. It also turns on mouse reporting (`?1003;1006h`): Codex scrolls, selects and copies on a
 * right click itself (terminal-views.ts). Unmeasured on a Codex older than the key, as a sandbox's
 * may be.
 */
const FULLSCREEN_ARGS = ["-c", "tui.fullscreen_transcript=true"];

export const codexAgent: AgentDefinition = {
  id: "codex",
  displayName: "Codex",
  executable: () => "codex",
  versionArgs: ["--version"],
  verifiedVersion: "0.156.1",
  // `--ephemeral` writes no rollout, so no cleanupAsk.
  askArgs: ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never"],
  sessions: codexSessionProvider,
  sessionIdOf: hookSessionId,
  prepareSpawn: (executable, paths) => {
    let args: string[] = FULLSCREEN_ARGS;
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
      args = [...FULLSCREEN_ARGS, ...setupCodexHooks()];
    } catch (error) {
      // See prepareSpawn: swallow, never reject.
      console.error("[tet] could not set up Codex hooks:", error);
    }
    return Promise.resolve({ args, executable: launcher });
  },
  prepareSandboxSpawn: () => {
    try {
      return { args: [...FULLSCREEN_ARGS, ...setupCodexHooks(SANDBOX_TARGET)] };
    } catch (error) {
      console.error("[tet] could not set up Codex sandbox hooks:", error);
      return { args: FULLSCREEN_ARGS };
    }
  },
  // Measured: skills in `~/.codex/skills` and `~/.agents/skills` (its "failed to load skill" log
  // names both); all of `~/.codex/plugins` (code under `plugins/cache/…`); `~/.codex/AGENTS.md`,
  // `AGENTS.override.md` preferred per its load order. Under the config root the sessions are read
  // from.
  sandboxKnowledge: () => {
    const home = codexHome();
    const instructionsHost = [path.join(home, "AGENTS.override.md"), path.join(home, "AGENTS.md")].find((file) => fs.existsSync(file));
    return {
      skills: [{ host: path.join(home, "skills"), target: `${SANDBOX_HOME}/.codex/skills` }],
      plugins: [{ host: path.join(home, "plugins"), target: `${SANDBOX_HOME}/.codex/plugins` }],
      instructions: instructionsHost ? [{ host: instructionsHost, target: `${SANDBOX_HOME}/.codex/AGENTS.md` }] : []
    };
  },
  sharedSkillsTarget: `${SANDBOX_HOME}/.agents/skills`,
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
  // Resize: see FULLSCREEN_ARGS.
};
