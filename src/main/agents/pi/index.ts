import * as path from "node:path";
import { watchTurnMarkers } from "../../terminals/marker-watch";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { writePiExtension } from "./extension";
import { piSessionProvider } from "./sessions";

/**
 * pi (pi.dev, `@earendil-works/pi-coding-agent`): a minimal TUI harness that is nearest to
 * Claude Code in how tet drives it — JSONL transcripts on disk, and turn signals from a file
 * tet generates and points it at. Every value here was measured through tet's own pty against
 * pi 0.85.1, never carried over from the agent next to it.
 *
 * Deliberately not set for the spawned process: `PI_CODING_AGENT_DIR` (it would move the
 * user's sessions and auth), `PI_OFFLINE` (pi writing `lastChangelogVersion` into its own
 * settings.json and downloading `fd` on first start is the user's business).
 */
export const piAgent: AgentDefinition = {
  id: "pi",
  displayName: "Pi",
  executable: () => "pi",
  // On win32 the npm install is a `pi.cmd` shim in %APPDATA%\npm, which resolveCommand already
  // routes through cmd.exe like Claude's and Codex's.
  versionArgs: ["--version"],
  installUrl: "https://pi.dev",
  // Print mode: stdin alone is the prompt, the answer comes on stdout (~2.6 s measured). Without
  // `--no-session` a transcript is left behind and would come back as a tab on the next start;
  // with it nothing is, so there is no cleanupAsk.
  askArgs: ["-p", "--no-session"],
  sessions: piSessionProvider,
  prepareSpawn: (_executable, cwd, paths) => {
    const args: string[] = [];
    const watchers: (() => void)[] = [];
    try {
      const extension = writePiExtension(paths.agentDir, path.basename(cwd), "Pi", paths.notifications, paths.contextFile);
      args.push("-e", extension);
      watchers.push(watchTurnMarkers(paths.agentDir, paths));
    } catch (error) {
      // Unlike Claude Code's hooks, a `-e` file pi cannot load is fatal to it (measured: it
      // prints "Failed to load extension" and exits). So a file that failed to write is not
      // passed at all — pi starts without turn marks and without the context file rather than
      // not at all — and the watcher is not armed, since nothing would ever write a marker. Not
      // a rejection either: that would mark the whole agent unstartable.
      console.error("[tet] could not write pi's extension:", error);
    }
    // pi's built-in themes are named after the background's kind, `dark` and `light`, and
    // `--use-theme` sets one for this run only — its settings.json stays untouched (measured).
    // Left out when the Appearance tab says to leave this agent's looks alone.
    if (paths.themeAgents) {
      args.push("--use-theme", paths.theme.kind);
    }
    // A fresh session's first busy marker waits in session-manager's pendingTurns until pi
    // writes the transcript, which it does only with the first assistant message; a first
    // answer taking longer than that queue's TTL loses its spinner, the finished mark still
    // lands. Known, and not worth a mechanism.
    return Promise.resolve({ args, dispose: () => watchers.forEach((stop) => stop()) });
  },
  // Measured startup: ~130 B of handshake by 120 ms, a 1037 B chunk at ~680 ms, a 1881 B chunk
  // at ~850 ms, ~3 KB in 0.9 s. With the project-trust dialog (a repository holding `.pi/`,
  // pi's default `defaultProjectTrust: "ask"`) output stops at 1458 B until the user answers, so
  // a threshold of 1500 would spin the bar until then; 1000 clears the handshake and reveals on
  // the first real chunk either way.
  createIsSessionReady: () => createByteThresholdCheck(1000),
  // One Ctrl+C clears the editor; two within 500 ms (pi's handleCtrlC) exit cleanly with code 0
  // in ~1.1 s, and 700 ms apart do nothing. TET's 250 ms gap and 2 s grace fit inside that.
  quitPresses: 2
  // Left out on purpose, each measured through this pty: plainCtrlCKills (pi runs raw and reads
  // \x03 as a byte), takesRightMouse (no mouse reporting at all — bracketed paste, focus events
  // and the kitty keyboard protocol are what it turns on), swapsBlueMagenta (truecolor `38;2`
  // sequences only, no palette indices, no OSC 10/11), resolveUrlPrefix (pi wraps a long url
  // across rows itself, but wraps each in OSC 8 with the full url, which the renderer's
  // linkHandler already opens).
};
