import * as path from "node:path";
import { sandboxHookDir, SANDBOX_TARGET } from "../../terminals/hook-target";
import { watchTurnMarkers } from "../../terminals/marker-watch";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { writePiExtension } from "./extension";
import { piSessionProvider } from "./sessions";

/**
 * pi (pi.dev, `@earendil-works/pi-coding-agent`): a minimal TUI harness driven through JSONL
 * transcripts on disk and turn signals from a file tet generates and points it at. Every value
 * here was measured through tet's own pty against pi 0.85.1.
 *
 * Deliberately not set for the spawned process: `PI_CODING_AGENT_DIR` (it would move the user's
 * sessions and auth) and `PI_OFFLINE`.
 *
 * A tab of it runs in an sbx sandbox through a community kit — see sbx.ts's SBX_CREATE_TARGET,
 * including that pi has no `/login`, so its Anthropic credential comes from sbx's own store.
 */
export const piAgent: AgentDefinition = {
  id: "pi",
  displayName: "Pi",
  executable: () => "pi",
  // On win32 the npm install is a `pi.cmd` shim, which resolveCommand routes through cmd.exe.
  versionArgs: ["--version"],
  installUrl: "https://pi.dev",
  // Print mode: stdin alone is the prompt, the answer comes on stdout (~2.6 s measured).
  // `--no-session` leaves no transcript behind, so there is no cleanupAsk.
  askArgs: ["-p", "--no-session"],
  sessions: piSessionProvider,
  prepareSpawn: (_executable, cwd, paths) => {
    const args: string[] = [];
    const watchers: (() => void)[] = [];
    try {
      const extension = writePiExtension(paths.agentDir, path.basename(cwd), "Pi", paths.notifications, paths.contextFile);
      args.push("-e", extension);
      watchers.push(watchTurnMarkers(paths.agentDir, paths));
      watchers.push(watchTurnMarkers(sandboxHookDir(paths.agentDir), paths));
    } catch (error) {
      // A `-e` file pi cannot load is fatal to it (measured: it prints "Failed to load
      // extension" and exits), so a file that failed to write is not passed at all and the
      // watcher is not armed. See prepareSpawn: swallow, never reject.
      console.error("[tet] could not write pi's extension:", error);
    }
    // pi's built-in themes are named after the background's kind, `dark` and `light`, and
    // `--use-theme` sets one for this run only — its settings.json stays untouched (measured).
    args.push("--use-theme", paths.theme.kind);
    // A fresh session's first busy marker waits in session-manager's pendingTurns until pi writes
    // the transcript, which it does only with the first assistant message; a first answer taking
    // longer than that queue's TTL loses its spinner. The finished mark still lands.
    return Promise.resolve({ args, dispose: () => watchers.forEach((stop) => stop()) });
  },
  prepareSandboxSpawn: (cwd, paths) => {
    try {
      const extension = writePiExtension(sandboxHookDir(paths.agentDir), path.basename(cwd), "Pi", paths.notifications, paths.contextFile, SANDBOX_TARGET);
      // The file is written at its host path and read at the sandbox's — agentDir is mounted
      // whole (sbx.ts's fixedMountSpecs) and this sits inside it. On a failed write pi is started
      // without the argument, never pointed at a file that is not there.
      // `-a`/`--approve` skips the project-trust dialog (pi has no other permission gate): the
      // sandbox is the safety boundary, same reasoning as Claude Code's and opencode's own flag.
      // The community pi-kit does not set this itself (measured, docker/sbx-kits-contrib pi/spec.yaml).
      return { args: ["-e", SANDBOX_TARGET.embed(extension), "--use-theme", paths.theme.kind, "-a"] };
    } catch (error) {
      console.error("[tet] could not write pi's sandbox extension:", error);
      return { args: ["--use-theme", paths.theme.kind, "-a"] };
    }
  },
  // Measured startup: ~130 B of handshake by 120 ms, a 1037 B chunk at ~680 ms, ~3 KB in 0.9 s.
  // With the project-trust dialog (`defaultProjectTrust: "ask"`) output stops at 1458 B until the
  // user answers, so 1500 would spin the bar until then; 1000 clears the handshake either way.
  createIsSessionReady: () => createByteThresholdCheck(1000),
  // One Ctrl+C clears the editor; two within 500 ms (pi's handleCtrlC) exit cleanly with code 0
  // in ~1.1 s, and 700 ms apart do nothing. TET's 250 ms gap and 2 s grace fit inside that.
  quitPresses: 2
  // Left out on purpose, each measured through this pty: takesRightMouse (no mouse reporting at
  // all), swapsBlueMagenta (truecolor
  // `38;2` only, no palette indices, no OSC 10/11), resolveUrlPrefix (pi wraps a long url in
  // OSC 8 with the full url, which the renderer's linkHandler already opens).
};
