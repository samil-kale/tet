import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_HOME, SANDBOX_TARGET } from "../hook-target";
import { createByteThresholdCheck } from "../session-ready";
import { writeIfChanged } from "../../util/generated-file";
import { codexIcon } from "./icon";
import type { ThemeDefinition } from "../../../shared/themes";
import type { SandboxedAgent } from "../agent";
import { hookSessionId } from "../hook-payload";
import { codexHookReply, setupCodexHooks } from "./hooks";
import { listModels } from "./app-server-client";
import { codexHome, codexSandboxSessions, codexSessionProvider } from "./sessions";
import { PLATFORM } from "../../util/host-platform";
import { logError } from "../../util/error-log";

/**
 * On win32 Codex reads its colors from the *console* (conhost's palette, whatever xterm draws) and
 * blends its composer and message boxes from it — near-black on a light theme.
 *
 * ConPTY reflects OSC 4 in that table: set entries 0 (background) and 7 (foreground) and Codex
 * reads the theme's colors; OSC 10/11 do not. It must come from inside the pty, so a generated
 * `.cmd` prints it (`<nul set /p`; `echo` adds a line) and runs Codex with `%*`. The OSC 4 also
 * reaches xterm, where `terminal-views.ts` swallows it.
 */
function writeConsoleColorLauncher(agentDir: string, executable: string, theme: ThemeDefinition): string {
  const rgb = (hex: string): string => `rgb:${hex.slice(1, 3)}/${hex.slice(3, 5)}/${hex.slice(5, 7)}`;
  const osc4 = `\x1b]4;0;${rgb(theme.terminalBackground)}\x1b\\\x1b]4;7;${rgb(theme.terminalForeground)}\x1b\\`;
  const launcher = path.join(agentDir, "launch.cmd");
  // Rename into place: a theme change rewrites it while a tab may be starting through it, and
  // cmd.exe reading it truncated runs nothing.
  writeIfChanged(launcher, `@echo off\r\n<nul set /p "=${osc4}"\r\n${executable} %*\r\n`);
  return launcher;
}

/**
 * Codex's fullscreen transcript, always: only there does it enter the alternate screen, so a resize
 * redraws in place instead of reprinting the whole transcript into the scrollback. It also turns on
 * mouse reporting (`?1003;1006h`): Codex scrolls, selects and copies on a right click itself
 * (terminal-views.ts).
 */
const FULLSCREEN_ARGS = ["-c", "tui.fullscreen_transcript=true"];

/**
 * `-c` overrides need Codex's embedded app server, not its shared background one: asked for
 * outright, it starts embedded without a startup warning.
 */
const BASE_ARGS = ["--no-daemon", ...FULLSCREEN_ARGS];

export const codexAgent: SandboxedAgent = {
  id: "codex",
  displayName: "Codex",
  icon: codexIcon,
  // Its input field is no shell: only a space needs quoting, in double quotes.
  quotePath: (path) => (/\s/.test(path) ? `"${path}"` : path),
  executable: () => "codex",
  install: { versionArgs: ["--version"], verifiedVersion: "0.159.2" },
  terminal: {
    // The positional prompt of an interactive session, after the `-c` options.
    initialPromptArgs: (prompt) => [prompt],
    // Above what setup and onboarding print before the first real redraw.
    createIsSessionReady: () => createByteThresholdCheck(600),
    // One Ctrl+C clears a non-empty composer and quits on an empty one; a second byte would land
    // mid-shutdown, where ConPTY turns it into a CTRL_C_EVENT that kills the shutdown.
    quitPresses: 1,
    // ESC+CR, which its input reads as a newline rather than a submit.
    shiftEnter: "\x1b\r"
  },
  // `--ephemeral` writes no rollout, so no session is left behind.
  ask: {
    args: ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never"],
    models: listModels,
    modelArgs: (model) => ["--model", model]
  },
  sessions: codexSessionProvider,
  // See AgentTurns.questionOutlivesTurn.
  turns: { sessionIdOf: hookSessionId, questionOutlivesTurn: true, hookReply: codexHookReply },
  host: {
    prepare: (executable, paths) => {
      let args: string[] = BASE_ARGS;
      let launcher: string | undefined;
      if (PLATFORM.conpty) {
        try {
          launcher = writeConsoleColorLauncher(paths.agentDir, executable, paths.theme);
        } catch (error) {
          // Codex still starts, drawing its boxes for a black console.
          logError("could not write Codex's launcher", error);
        }
      }
      try {
        args = [...BASE_ARGS, ...setupCodexHooks()];
      } catch (error) {
        // See AgentHost.prepare: swallow, never reject.
        logError("could not set up Codex hooks", error);
      }
      return Promise.resolve({ args, executable: launcher });
    }
  },
  sandbox: {
    prepare: () => {
      try {
        return { args: [...BASE_ARGS, ...setupCodexHooks(SANDBOX_TARGET)] };
      } catch (error) {
        logError("could not set up Codex sandbox hooks", error);
        return { args: BASE_ARGS };
      }
    },
    // Skills in `~/.codex/skills` and `~/.agents/skills`; all of `~/.codex/plugins`;
    // `~/.codex/AGENTS.md`, `AGENTS.override.md` preferred. Under the config root the sessions are
    // read from.
    knowledge: () => {
      const home = codexHome();
      const instructionsHost = [path.join(home, "AGENTS.override.md"), path.join(home, "AGENTS.md")].find((file) => fs.existsSync(file));
      return {
        skills: [{ host: path.join(home, "skills"), target: `${SANDBOX_HOME}/.codex/skills` }],
        plugins: [{ host: path.join(home, "plugins"), target: `${SANDBOX_HOME}/.codex/plugins` }],
        instructions: instructionsHost ? [{ host: instructionsHost, target: `${SANDBOX_HOME}/.codex/AGENTS.md` }] : []
      };
    },
    sharedSkillsTarget: `${SANDBOX_HOME}/.agents/skills`,
    sessions: codexSandboxSessions
  }
};
