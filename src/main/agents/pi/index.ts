import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SANDBOX_HOME, sandboxHookDir, SANDBOX_TARGET } from "../../terminals/hook-target";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { hookSessionId } from "../hook-payload";
import { writePiExtension } from "./extension";
import { piSessionProvider } from "./sessions";
import { TET_SYSTEM_PROMPT } from "../system-prompt";

/** Appended to pi's system prompt for this run; through pi's npm shim and cmd.exe on win32
 *  (measured, see system-prompt.ts). */
const SYSTEM_PROMPT_ARGS = ["--append-system-prompt", TET_SYSTEM_PROMPT];

/**
 * pi (pi.dev, `@earendil-works/pi-coding-agent`): a minimal TUI read through JSONL transcripts,
 * reporting turns through a generated extension. Every value here measured through tet's pty
 * against pi 0.85.1.
 *
 * Deliberately unset: `PI_CODING_AGENT_DIR` (would move the user's sessions and auth) and
 * `PI_OFFLINE`.
 *
 * Sandboxed through a community kit — see `sandboxKit` (pi has no `/login`; its Anthropic credential
 * comes from sbx's store).
 */
export const piAgent: AgentDefinition = {
  id: "pi",
  displayName: "Pi",
  executable: () => "pi",
  // On win32 a `pi.cmd` npm shim, routed through cmd.exe by resolveCommand.
  versionArgs: ["--version"],
  verifiedVersion: "0.85.1",
  // Print mode: the prompt on stdin, the answer on stdout (~2.6 s measured). `--no-session` leaves
  // no transcript, so no cleanupAsk.
  askArgs: ["-p", "--no-session"],
  sessions: piSessionProvider,
  // The extension sends the session manager's id with every report.
  sessionIdOf: hookSessionId,
  prepareSpawn: (_executable, _cwd, paths) => {
    const args: string[] = [];
    try {
      const extension = writePiExtension(paths.agentDir);
      args.push("-e", extension);
    } catch (error) {
      // An unloadable `-e` file is fatal (measured: "Failed to load extension", exit), so an
      // unwritten one is not passed. Swallow, never reject (see prepareSpawn).
      console.error("[tet] could not write pi's extension:", error);
    }
    // Built-in themes are `dark` and `light`; `--use-theme` applies to this run only, leaving
    // settings.json untouched (measured).
    args.push("--use-theme", paths.theme.kind, ...SYSTEM_PROMPT_ARGS);
    return Promise.resolve({ args });
  },
  prepareSandboxSpawn: (_cwd, paths) => {
    try {
      const extension = writePiExtension(sandboxHookDir(paths.agentDir));
      // Written at the host path, read at the sandbox's: agentDir is mounted whole (sbx.ts's
      // fixedMountSpecs). On a failed write pi starts without `-e`.
      // `-a`/`--approve` skips the project-trust dialog (pi's only gate): the sandbox is the safety
      // boundary, as for Claude Code and opencode. The community pi-kit does not set it (measured,
      // docker/sbx-kits-contrib pi/spec.yaml).
      return { args: ["-e", SANDBOX_TARGET.embed(extension), "--use-theme", paths.theme.kind, "-a", ...SYSTEM_PROMPT_ARGS] };
    } catch (error) {
      console.error("[tet] could not write pi's sandbox extension:", error);
      return { args: ["--use-theme", paths.theme.kind, "-a", ...SYSTEM_PROMPT_ARGS] };
    }
  },
  // Per pi's bundled docs (0.85.1): skills in `~/.pi/agent/skills` and `~/.agents/skills`,
  // extensions in `~/.pi/agent/extensions`, `~/.pi/agent/AGENTS.md` (`AGENTS.override.md`
  // preferred) — at their defaults, as `PI_CODING_AGENT_DIR` is never set.
  sandboxKnowledge: () => {
    const home = os.homedir();
    const instructionsHost = [path.join(home, ".pi", "agent", "AGENTS.override.md"), path.join(home, ".pi", "agent", "AGENTS.md")].find((file) => fs.existsSync(file));
    return {
      skills: [
        { host: path.join(home, ".pi", "agent", "skills"), target: `${SANDBOX_HOME}/.pi/agent/skills` },
        { host: path.join(home, ".agents", "skills"), target: `${SANDBOX_HOME}/.agents/skills` }
      ],
      plugins: [{ host: path.join(home, ".pi", "agent", "extensions"), target: `${SANDBOX_HOME}/.pi/agent/extensions` }],
      instructions: instructionsHost ? [{ host: instructionsHost, target: `${SANDBOX_HOME}/.pi/agent/AGENTS.md` }] : []
    };
  },
  // pi has no built-in kit (not in `sbx create --help` at 0.42.1), so it is the community kit
  // (docker/sbx-kits-contrib), whose image (shell-docker plus pi, rebuilt nightly) sbx pulls on the
  // first create — nothing installed here; home is `/home/agent` like every built-in.
  //
  // Verified live, 2026-09-09, sbx 0.42.1 (0.39.0 cannot read the kit's v2 manifest):
  // - it is the *first positional*; `--kit` is deprecated there and means a mixin onto a built-in.
  // - only `create` needs it: `sbx run` reattaches by `--name`, and `prepareSbxRun` passes plain
  //   `pi`, the name the kit declares (and `sbx ls --json`'s `agent`).
  // - auth is not tet's: pi has no `/login`, so its kit takes an Anthropic credential from sbx's
  //   store (`sbx secret set anthropic`, a `claude` sandbox's OAuth login, or `claude setup-token`).
  //   Without one the sandbox starts and every model call is a 401.
  sandboxKit: "docker.io/sbx/pi-kit:latest",
  // Measured startup: ~130 B handshake by 120 ms, a 1037 B chunk at ~680 ms, ~3 KB by 0.9 s. The
  // project-trust dialog (`defaultProjectTrust: "ask"`) holds output at 1458 B until answered, so
  // 1000 clears the handshake either way without spinning until then.
  createIsSessionReady: () => createByteThresholdCheck(1000),
  // One Ctrl+C clears the editor; two within 500 ms (pi's handleCtrlC) exit 0 in ~1.1 s, 700 ms
  // apart do nothing. TET's 250 ms gap and 2 s grace fit.
  quitPresses: 2
  // Omitted on purpose, each measured: takesRightMouse (no mouse reporting), swapsBlueMagenta
  // (truecolor `38;2` only, no palette indices, no OSC 10/11), resolveUrlPrefix (a long url comes
  // in OSC 8 with the full url, which the renderer's linkHandler opens).
};
