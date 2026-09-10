import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { sandboxHookDir, SANDBOX_TARGET } from "../../terminals/hook-target";
import { claudeHoldsTurnEnd, setupClaudeHooks } from "./hooks";
import { claudeSessionProvider } from "./sessions";

export const claudeAgent: AgentDefinition = {
  id: "claude",
  displayName: "Claude",
  executable: () => "claude",
  versionArgs: ["--version"],
  // Print mode; `--no-session-persistence` leaves no transcript behind (it would become a tab).
  askArgs: ["-p", "--no-session-persistence"],
  sessions: claudeSessionProvider,
  holdsTurnEnd: claudeHoldsTurnEnd,
  prepareSpawn: (_executable, _cwd, paths) => {
    let args: string[] = [];
    try {
      args = setupClaudeHooks(paths.agentDir, paths, paths.theme.kind);
    } catch (error) {
      // Swallowed, never rejected — see AgentDefinition.prepareSpawn.
      console.error("[tet] could not write Claude hook settings:", error);
    }
    return Promise.resolve({ args });
  },
  prepareSandboxSpawn: (_cwd, paths) => {
    try {
      return { args: setupClaudeHooks(sandboxHookDir(paths.agentDir), paths, paths.theme.kind, SANDBOX_TARGET) };
    } catch (error) {
      console.error("[tet] could not write Claude sandbox hook settings:", error);
      return { args: [] };
    }
  },
  // See AgentDefinition.sandboxEnv.
  sandboxEnv: ["CLAUDE_CODE_NO_FLICKER=1"],
  // Measured: the startup handshake is under 150 bytes, the main UI redraw one ~850-byte
  // chunk; 500 reveals as that chunk lands. A higher threshold is not reliably reached.
  createIsSessionReady: () => createByteThresholdCheck(500),
  // The first only offers to exit, the second takes it up.
  quitPresses: 2,
  // Its Ink TUI handles the right click itself (it pastes).
  takesRightMouse: true
};
