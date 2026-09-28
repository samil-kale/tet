import * as path from "node:path";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import { claudeIcon } from "./icon";
import type { SandboxedAgent } from "../agent";
import { hookSessionId } from "../hook-payload";
import { SANDBOX_HOME, SANDBOX_TARGET } from "../../terminals/hook-target";
import { claudeHookReply, claudeWorkOutlivesStop, setupClaudeHooks } from "./hooks";
import { claudeConfigDir, claudeSandboxSessions, claudeSessionProvider } from "./sessions";
import { systemPrompt } from "../system-prompt";
import { HOST_SIDE, SANDBOX_SIDE, type ControlSide } from "../../../shared/control-side";

/** Appended to Claude Code's own system prompt for this process (see system-prompt.ts). */
const systemPromptArgs = (side: ControlSide): string[] => ["--append-system-prompt", systemPrompt(side)];

/**
 * Fullscreen, always: Claude Code turns it off machine-wide after launches that died while it
 * booted (terminal-session.ts), and this variable overrides that.
 */
const FULLSCREEN_ENV = { CLAUDE_CODE_NO_FLICKER: "1" };

export const claudeAgent: SandboxedAgent = {
  id: "claude",
  displayName: "Claude",
  icon: claudeIcon,
  // Its input field is no shell: only a space needs quoting, in double quotes.
  quotePath: (path) => (/\s/.test(path) ? `"${path}"` : path),
  executable: () => "claude",
  install: { versionArgs: ["--version"], verifiedVersion: "2.1.282" },
  terminal: {
    // The positional prompt of an interactive session.
    initialPromptArgs: (prompt) => [prompt],
    // Above the start-up handshake, below the chunk that draws the main UI.
    createIsSessionReady: () => createByteThresholdCheck(500),
    // The first only offers to exit, the second takes it up.
    quitPresses: 2
  },
  // Print mode; `--no-session-persistence` leaves no transcript behind (it would become a tab).
  ask: { args: ["-p", "--no-session-persistence"] },
  sessions: claudeSessionProvider,
  turns: { sessionIdOf: hookSessionId, workOutlivesStop: claudeWorkOutlivesStop, hookReply: claudeHookReply },
  host: {
    prepare: (_executable, paths) => {
      let args: string[] = [];
      try {
        args = setupClaudeHooks(paths);
      } catch (error) {
        // Swallowed, never rejected — see AgentHost.prepare.
        console.error("[tet] could not write Claude hook settings:", error);
      }
      return Promise.resolve({ args: [...args, ...systemPromptArgs(HOST_SIDE)], env: FULLSCREEN_ENV });
    }
  },
  sandbox: {
    prepare: (paths) => {
      try {
        return { args: [...setupClaudeHooks(paths, SANDBOX_TARGET), ...systemPromptArgs(SANDBOX_SIDE)] };
      } catch (error) {
        console.error("[tet] could not write Claude sandbox hook settings:", error);
        return { args: systemPromptArgs(SANDBOX_SIDE) };
      }
    },
    // Claude Code falls back to its classic renderer where the sandbox's network rule blocks its
    // feature flags; this forces fullscreen.
    env: Object.entries(FULLSCREEN_ENV).map(([key, value]) => `${key}=${value}`),
    // `~/.claude/skills`, `~/.claude/plugins`, `~/.claude/CLAUDE.md` — under the config root the
    // sessions are read from.
    knowledge: () => ({
      skills: [{ host: path.join(claudeConfigDir(), "skills"), target: `${SANDBOX_HOME}/.claude/skills` }],
      plugins: [{ host: path.join(claudeConfigDir(), "plugins"), target: `${SANDBOX_HOME}/.claude/plugins` }],
      instructions: [{ host: path.join(claudeConfigDir(), "CLAUDE.md"), target: `${SANDBOX_HOME}/.claude/CLAUDE.md` }]
    }),
    // No `sharedSkillsTarget`: Claude Code reads only its own skills folder, and putting
    // `~/.agents/skills` there would stand in for it.
    sessions: claudeSandboxSessions
  }
};
