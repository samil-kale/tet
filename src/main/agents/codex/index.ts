import * as fs from "node:fs";
import * as path from "node:path";
import { watchTurnMarkers } from "../../terminals/marker-watch";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { ThemeDefinition } from "../../../shared/themes";
import type { AgentDefinition } from "../agent";
import { setupCodexHooks } from "./hooks";
import { codexSessionProvider } from "./sessions";

/**
 * On win32 Codex does not ask the terminal for its colors (OSC 10/11 — xterm answers those,
 * and that is what it does elsewhere) but the *console*: `GetConsoleScreenBufferInfoEx` on
 * the ConPTY between us, whose own palette is conhost's Campbell default whatever xterm
 * draws — black behind light gray. Codex blends its composer and user-message boxes from
 * that, so on a light theme they came out near-black on white (measured).
 *
 * What ConPTY *does* reflect in that table is OSC 4 — set entry 0 (the default background's
 * index) and 7 (the foreground's) and Codex reads the theme's colors back (measured: the
 * box turns light with the theme). OSC 10/11 change nothing there. The
 * sequence has to be written by a process inside the pty, hence a generated launcher: a
 * `.cmd` that prints it (`<nul set /p` — `echo` would add a line) and hands over to Codex
 * with `%*`, the same `cmd.exe /d /s /c` path an npm `codex.cmd` shim took. ConPTY forwards
 * the OSC 4 to xterm too, which `terminal-views.ts` swallows — otherwise xterm's own ANSI
 * black and white would turn into the theme's background and foreground.
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
  installUrl: "https://github.com/openai/codex",
  // `--ephemeral` skips the rollout file entirely, so nothing is left behind for cleanupAsk to
  // remove — the same reasoning as Claude's `--no-session-persistence`.
  askArgs: ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never"],
  sessions: codexSessionProvider,
  prepareSpawn: (executable, cwd, paths) => {
    let args: string[] = [];
    let launcher: string | undefined;
    const watchers: (() => void)[] = [];
    if (process.platform === "win32") {
      try {
        launcher = writeConsoleColorLauncher(paths.agentDir, executable, paths.theme);
      } catch (error) {
        // Codex itself still starts without it, only drawing its boxes for a black console.
        console.error("[tet] could not write Codex's launcher:", error);
      }
    }
    try {
      args = setupCodexHooks(paths.agentDir, "Codex", paths.notifications, path.basename(cwd), paths.contextFile);
      // Codex's own syntax-theme accents (status line, code highlighting) default to a fixed
      // RGB theme (catppuccin) picked by a light/dark guess, ignoring the terminal's own ANSI
      // palette entirely. "ansi" is the one bundled theme that emits plain named ANSI colors
      // instead — verified end to end: with this override, the status line's model name and cwd
      // path render in exactly tet's configured ansiYellow/ansiGreen instead of a hardcoded
      // catppuccin tan/green. The key is `tui.theme`, not `tui_theme` — that's the Rust struct
      // field name, but `-c`'s dotted path follows the TOML layout (`[tui]\ntheme = "..."`,
      // `codex-rs/config/src/types.rs`), and only the dotted form actually takes effect.
      // Left out when the Appearance tab says to leave the agents alone — the launcher above
      // stays, since which way the background is isn't a matter of taste.
      if (paths.themeAgents) {
        args.push("-c", "tui.theme=ansi");
      }
      watchers.push(watchTurnMarkers(paths.agentDir, paths));
    } catch (error) {
      // As with Claude, losing the hooks must not keep Codex from starting — swallowed rather
      // than rejected, since a rejection here marks the whole agent unstartable.
      console.error("[tet] could not set up Codex hooks:", error);
    }
    return Promise.resolve({ args, executable: launcher, dispose: () => watchers.forEach((stop) => stop()) });
  },
  // No documented readiness signal (no port, no log line, no flag) — a plain byte count, tuned
  // against the TUI's own startup frames observed on a real install: setup/onboarding chunks
  // total a few hundred bytes before the first real redraw, itself a single ~700-900 byte chunk.
  // Unverified against a *logged-in* start, which may draw less before the first redraw — revisit
  // once that is checked.
  createIsSessionReady: () => createByteThresholdCheck(600),
  // One: a second byte would land mid-shutdown and kill it instead.
  quitPresses: 1,
  // Cooked mode: on win32 the byte arrives as a CTRL_C_EVENT and kills it, so it is never sent.
  plainCtrlCKills: true
};
