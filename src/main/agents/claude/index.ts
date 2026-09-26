import * as path from "node:path";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { hookSessionId } from "../hook-payload";
import { SANDBOX_HOME, SANDBOX_TARGET } from "../../terminals/hook-target";
import { claudeWorkOutlivesStop, setupClaudeHooks } from "./hooks";
import { claudeConfigDir, claudeSessionProvider } from "./sessions";
import { systemPrompt } from "../system-prompt";

/** Appended to Claude Code's own system prompt for this process (see system-prompt.ts). */
const systemPromptArgs = (sandboxed: boolean): string[] => ["--append-system-prompt", systemPrompt(sandboxed)];

/**
 * Fullscreen, always: Claude Code turns it off machine-wide after launches that died while it
 * booted (terminal-session.ts), and this variable overrides that.
 */
const FULLSCREEN_ENV = { CLAUDE_CODE_NO_FLICKER: "1" };

export const claudeAgent: AgentDefinition = {
  id: "claude",
  displayName: "Claude",
  executable: () => "claude",
  versionArgs: ["--version"],
  verifiedVersion: "2.1.282",
  // Print mode; `--no-session-persistence` leaves no transcript behind (it would become a tab).
  askArgs: ["-p", "--no-session-persistence"],
  sessions: claudeSessionProvider,
  sessionIdOf: hookSessionId,
  workOutlivesStop: claudeWorkOutlivesStop,
  prepareSpawn: (_executable, paths) => {
    let args: string[] = [];
    try {
      args = setupClaudeHooks(paths.agentDir, paths, paths.theme.kind);
    } catch (error) {
      // Swallowed, never rejected — see AgentDefinition.prepareSpawn.
      console.error("[tet] could not write Claude hook settings:", error);
    }
    return Promise.resolve({ args: [...args, ...systemPromptArgs(false)], env: FULLSCREEN_ENV });
  },
  prepareSandboxSpawn: (paths) => {
    try {
      return { args: [...setupClaudeHooks(paths.agentDir, paths, paths.theme.kind, SANDBOX_TARGET), ...systemPromptArgs(true)] };
    } catch (error) {
      console.error("[tet] could not write Claude sandbox hook settings:", error);
      return { args: systemPromptArgs(true) };
    }
  },
  // Claude Code falls back to its classic renderer where the sandbox's network rule blocks its
  // feature flags; this forces fullscreen.
  sandboxEnv: ["CLAUDE_CODE_NO_FLICKER=1"],
  // `~/.claude/skills`, `~/.claude/plugins`, `~/.claude/CLAUDE.md` — under the config root the
  // sessions are read from.
  sandboxKnowledge: () => ({
    skills: [{ host: path.join(claudeConfigDir(), "skills"), target: `${SANDBOX_HOME}/.claude/skills` }],
    plugins: [{ host: path.join(claudeConfigDir(), "plugins"), target: `${SANDBOX_HOME}/.claude/plugins` }],
    instructions: [{ host: path.join(claudeConfigDir(), "CLAUDE.md"), target: `${SANDBOX_HOME}/.claude/CLAUDE.md` }]
  }),
  // No `sharedSkillsTarget`: Claude Code reads only its own skills folder, and putting
  // `~/.agents/skills` there would stand in for it.
  // Above the start-up handshake, below the chunk that draws the main UI.
  createIsSessionReady: () => createByteThresholdCheck(500),
  // The first only offers to exit, the second takes it up.
  quitPresses: 2
};
