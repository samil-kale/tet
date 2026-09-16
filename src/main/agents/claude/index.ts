import * as os from "node:os";
import * as path from "node:path";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { hookSessionId } from "../hook-payload";
import { SANDBOX_HOME, sandboxHookDir, SANDBOX_TARGET } from "../../terminals/hook-target";
import { claudeHoldsTurnEnd, setupClaudeHooks } from "./hooks";
import { claudeSessionProvider } from "./sessions";
import { TET_SYSTEM_PROMPT } from "../system-prompt";

/** Appended to Claude Code's own system prompt for this process (measured, see system-prompt.ts). */
const SYSTEM_PROMPT_ARGS = ["--append-system-prompt", TET_SYSTEM_PROMPT];

export const claudeAgent: AgentDefinition = {
  id: "claude",
  displayName: "Claude",
  executable: () => "claude",
  versionArgs: ["--version"],
  verifiedVersion: "2.1.273",
  // Print mode; `--no-session-persistence` leaves no transcript behind (it would become a tab).
  askArgs: ["-p", "--no-session-persistence"],
  sessions: claudeSessionProvider,
  holdsTurnEnd: claudeHoldsTurnEnd,
  sessionIdOf: hookSessionId,
  prepareSpawn: (_executable, _cwd, paths) => {
    let args: string[] = [];
    try {
      args = setupClaudeHooks(paths.agentDir, paths, paths.theme.kind);
    } catch (error) {
      // Swallowed, never rejected — see AgentDefinition.prepareSpawn.
      console.error("[tet] could not write Claude hook settings:", error);
    }
    return Promise.resolve({ args: [...args, ...SYSTEM_PROMPT_ARGS] });
  },
  prepareSandboxSpawn: (_cwd, paths) => {
    try {
      return { args: [...setupClaudeHooks(sandboxHookDir(paths.agentDir), paths, paths.theme.kind, SANDBOX_TARGET), ...SYSTEM_PROMPT_ARGS] };
    } catch (error) {
      console.error("[tet] could not write Claude sandbox hook settings:", error);
      return { args: SYSTEM_PROMPT_ARGS };
    }
  },
  // See AgentDefinition.sandboxEnv.
  sandboxEnv: ["CLAUDE_CODE_NO_FLICKER=1"],
  // Measured: `~/.claude/skills`, `~/.claude/plugins`, `~/.claude/CLAUDE.md`.
  sandboxKnowledge: () => ({
    skills: [{ host: path.join(os.homedir(), ".claude", "skills"), target: `${SANDBOX_HOME}/.claude/skills` }],
    plugins: [{ host: path.join(os.homedir(), ".claude", "plugins"), target: `${SANDBOX_HOME}/.claude/plugins` }],
    instructions: [{ host: path.join(os.homedir(), ".claude", "CLAUDE.md"), target: `${SANDBOX_HOME}/.claude/CLAUDE.md` }]
  }),
  // Measured: the startup handshake is under 150 bytes, the main UI one ~850-byte chunk; a higher
  // threshold than 500 is not reliably reached.
  createIsSessionReady: () => createByteThresholdCheck(500),
  // The first only offers to exit, the second takes it up.
  quitPresses: 2,
  // Its Ink TUI takes the right click (it pastes).
  takesRightMouse: true
};
