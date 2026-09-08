import * as path from "node:path";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { watchTurnMarkers } from "../../terminals/marker-watch";
import { sandboxTarget } from "../../terminals/os-notify";
import { setupClaudeHooks } from "./hooks";
import { claudeSessionProvider } from "./sessions";

/** Where a sandboxed session's own hook scripts/settings live — a subdirectory of the same
 *  agentDir a host session uses, so the two never overwrite each other's tet-hooks-settings.json
 *  (a host one is posix/win32-specific and path-literal; a sandboxed one is always posix with
 *  container-translated paths) while still sitting inside the one folder sbx.ts mounts whole. */
function sandboxHookDir(agentDir: string): string {
  return path.join(agentDir, "sandbox");
}

export const claudeAgent: AgentDefinition = {
  id: "claude",
  displayName: "Claude",
  executable: () => "claude",
  versionArgs: ["--version"],
  installUrl: "https://docs.claude.com/en/docs/claude-code/setup",
  // Print mode: one prompt, the answer on stdout. `--no-session-persistence` is what keeps it
  // from leaving a transcript behind — one would come back as a tab on the next start.
  askArgs: ["-p", "--no-session-persistence"],
  sessions: claudeSessionProvider,
  prepareSpawn: (_executable, cwd, paths) => {
    let args: string[] = [];
    const watchers: (() => void)[] = [];
    try {
      args = setupClaudeHooks(
        paths.agentDir,
        cwd,
        "Claude",
        paths.notifications,
        paths,
        paths.theme.kind
      );
      watchers.push(watchTurnMarkers(paths.agentDir, paths));
      // A sandboxed tab's own markers land under the same agentDir's "sandbox" subfolder (see
      // sandboxHookDir) rather than colliding with the host hook files above — watched
      // separately so either kind of tab's turn is picked up by the one runtime this is.
      watchers.push(watchTurnMarkers(sandboxHookDir(paths.agentDir), paths));
    } catch (error) {
      // Unlike opencode's server, these hooks are not what makes the CLI usable — losing
      // the notifications must not keep Claude from starting, so this is swallowed rather
      // than rejected (a rejection marks the whole agent as unstartable).
      console.error("[tet] could not write Claude hook settings:", error);
    }
    return Promise.resolve({ args, dispose: () => watchers.forEach((stop) => stop()) });
  },
  prepareSandboxSpawn: (cwd, paths) => {
    try {
      return setupClaudeHooks(sandboxHookDir(paths.agentDir), cwd, "Claude", paths.notifications, paths, paths.theme.kind, sandboxTarget());
    } catch (error) {
      console.error("[tet] could not write Claude sandbox hook settings:", error);
      return [];
    }
  },
  // Tuned empirically: Claude Code doesn't draw an early splash before its real UI, so a plain
  // byte count does — 500 sits comfortably above its startup handshake (well under
  // 150 bytes) and below its main UI redraw, which arrives as a single ~850-byte chunk. A
  // few tiny trailing chunks can still follow a second later, but a fresh session's total
  // doesn't reliably clear a threshold set to catch those too — better to reveal right as
  // the main chunk lands.
  createIsSessionReady: () => createByteThresholdCheck(500),
  // Two: the first only offers to exit, the second takes it up.
  quitPresses: 2,
  // Its Ink TUI handles the right click itself (it pastes).
  takesRightMouse: true
};
