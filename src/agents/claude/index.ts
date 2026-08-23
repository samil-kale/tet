import { createByteThresholdCheck } from "../../main/session-ready";
import type { AgentDefinition } from "../agent";
import { setupClaudeHooks, watchMarkers } from "./hooks";
import { claudeSessionProvider } from "./sessions";

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
        paths.themeAgents ? paths.theme.claudeTheme : undefined
      );
      // A hook is a process of its own and cannot call back into tet, so each end of a turn
      // — and the point part-way through where it stops for an answer — leaves a file behind,
      // and these are what pick them up.
      watchers.push(watchMarkers(paths.agentDir, "busy", paths.onSessionBusy));
      watchers.push(watchMarkers(paths.agentDir, "finished", paths.onSessionFinished));
      watchers.push(watchMarkers(paths.agentDir, "waiting", paths.onSessionWaiting));
    } catch (error) {
      // Unlike opencode's server, these hooks are not what makes the CLI usable — losing
      // the notifications must not keep Claude from starting, so this is swallowed rather
      // than rejected (a rejection marks the whole agent as unstartable).
      console.error("[tet] could not write Claude hook settings:", error);
    }
    return Promise.resolve({ args, dispose: () => watchers.forEach((stop) => stop()) });
  },
  // Tuned empirically: Claude Code doesn't draw an early splash before its real UI, so a plain
  // byte count does — 500 sits comfortably above its startup handshake (well under
  // 150 bytes) and below its main UI redraw, which arrives as a single ~850-byte chunk. A
  // few tiny trailing chunks can still follow a second later, but a fresh session's total
  // doesn't reliably clear a threshold set to catch those too — better to reveal right as
  // the main chunk lands.
  createIsSessionReady: () => createByteThresholdCheck(500),
  // Two: the first only offers to exit, the second takes it up.
  quitPresses: 2
};
