import * as fs from "node:fs";
import * as path from "node:path";
import { SANDBOX_HOME, SANDBOX_TARGET } from "../../terminals/hook-target";
import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { hookSessionId } from "../hook-payload";
import { writePiExtension } from "./extension";
import { piAgentDir, piSessionProvider } from "./sessions";
import { systemPrompt } from "../system-prompt";

/** Appended to pi's system prompt for this run; through pi's npm shim and cmd.exe on win32 (see
 *  system-prompt.ts). */
const systemPromptArgs = (sandboxed: boolean): string[] => ["--append-system-prompt", systemPrompt(sandboxed)];

/**
 * pi's fullscreen TUI (`--tui-mode`, this run only — settings.json untouched): it enters the
 * alternate screen and owns the viewport, so a resize redraws in place. It also turns on
 * mouse reporting (`?1000;1002;1006h`): pi scrolls, selects and pastes on a right click itself
 * (terminal-views.ts).
 */
const FULLSCREEN_ARGS = ["--tui-mode", "fullscreen"];

/**
 * pi (`@earendil-works/pi-coding-agent`): a minimal TUI read through JSONL transcripts, reporting
 * turns through a generated extension.
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
  verifiedVersion: "0.86.1",
  // Print mode: the prompt on stdin, the answer on stdout. `--no-session` leaves no transcript, so
  // no cleanupAsk.
  askArgs: ["-p", "--no-session"],
  sessions: piSessionProvider,
  // The extension sends the session manager's id with every report.
  sessionIdOf: hookSessionId,
  prepareSpawn: (_executable, paths) => {
    const args: string[] = [];
    try {
      const extension = writePiExtension(paths.agentDir);
      args.push("-e", extension);
    } catch (error) {
      // An unloadable `-e` file is fatal, so an unwritten one is not passed. Swallow, never reject
      // (see prepareSpawn).
      console.error("[tet] could not write pi's extension:", error);
    }
    // Built-in themes are `dark` and `light`; `--use-theme` applies to this run only, leaving
    // settings.json untouched.
    args.push(...FULLSCREEN_ARGS, "--use-theme", paths.theme.kind, ...systemPromptArgs(false));
    return Promise.resolve({ args });
  },
  prepareSandboxSpawn: (paths) => {
    try {
      const extension = writePiExtension(paths.agentDir);
      // Written at the host path, read at the sandbox's: the sandbox's agentDir is mounted whole
      // (sbx.ts's fixedMountSpecs). On a failed write pi starts without `-e`.
      // `-a`/`--approve` skips the project-trust dialog (pi's only gate): the sandbox is the safety
      // boundary, as for Claude Code, and the pi kit does not set it.
      return { args: ["-e", SANDBOX_TARGET.embed(extension), ...FULLSCREEN_ARGS, "--use-theme", paths.theme.kind, "-a", ...systemPromptArgs(true)] };
    } catch (error) {
      console.error("[tet] could not write pi's sandbox extension:", error);
      return { args: [...FULLSCREEN_ARGS, "--use-theme", paths.theme.kind, "-a", ...systemPromptArgs(true)] };
    }
  },
  // Skills in `~/.pi/agent/skills` and `~/.agents/skills`, extensions in `~/.pi/agent/extensions`,
  // `~/.pi/agent/AGENTS.md` (`AGENTS.override.md` preferred) — under the agent dir the sessions
  // are read from.
  sandboxKnowledge: () => {
    const agentDir = piAgentDir();
    const instructionsHost = [path.join(agentDir, "AGENTS.override.md"), path.join(agentDir, "AGENTS.md")].find((file) => fs.existsSync(file));
    return {
      skills: [{ host: path.join(agentDir, "skills"), target: `${SANDBOX_HOME}/.pi/agent/skills` }],
      plugins: [{ host: path.join(agentDir, "extensions"), target: `${SANDBOX_HOME}/.pi/agent/extensions` }],
      instructions: instructionsHost ? [{ host: instructionsHost, target: `${SANDBOX_HOME}/.pi/agent/AGENTS.md` }] : []
    };
  },
  sharedSkillsTarget: `${SANDBOX_HOME}/.agents/skills`,
  // pi has no built-in kit, so it is the community kit, whose image sbx pulls on the first create;
  // home is `/home/agent` like every built-in. It is `create`'s first positional (`--kit` means a
  // mixin); `sbx run` reattaches by `--name` with plain `pi`. Auth is not tet's: the kit takes an
  // Anthropic credential from sbx's store, without which every model call fails.
  sandboxKit: "docker.io/sbx/pi-kit:latest",
  // Above the start-up handshake and below what the project-trust dialog shows while it waits for
  // an answer.
  createIsSessionReady: () => createByteThresholdCheck(1000),
  // One Ctrl+C clears the editor; two in quick succession exit, which TET's gap between presses
  // meets.
  quitPresses: 2
};
