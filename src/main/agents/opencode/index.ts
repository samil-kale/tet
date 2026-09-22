import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOST_TARGET, SANDBOX_HOME, SANDBOX_TARGET } from "../../terminals/hook-target";
import { createNonAsciiThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { hookSessionId } from "../hook-payload";
import { runOpencode } from "./cli";
import { sandboxConfigDir, writeOpencodePlugin } from "./plugin";
import { resolveOpencodeUrlPrefix } from "./session-urls";
import { opencodeSessionProvider, registerAgentDir } from "./sessions";
import { installTuiConfig } from "./tui-config";

/** A background question's session title, so cleanupAsk can find it. */
const ASK_TITLE = "tet: background question";

/** The host's plugin directory, shared across repositories (plugin.ts). */
function hostConfigDir(storageRoot: string): string {
  return path.join(storageRoot, "opencode-plugins");
}

/**
 * Each tab runs the plain `opencode`: its server is a worker thread of that process (measured: the
 * plugin loads in `src/cli/tui/worker.js`, nothing listens on a port), and a generated plugin
 * reports turns and sessions and appends TET's system prompt (plugin.ts). Same on host and in sbx.
 * No `opencode serve` or `attach` of tet's own.
 */
export const opencodeAgent: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  executable: () => "opencode",
  versionArgs: ["--version"],
  verifiedVersion: "1.18.4",
  /*
   * Non-interactive mode. It cannot skip persisting the session, so the run is titled for
   * `cleanupAsk`.
   */
  askArgs: ["run", "--title", ASK_TITLE],
  // The question runs without the plugin (askAgent uses the machine's environment), so no record:
  // opencode's own listing must find it, one process each.
  cleanupAsk: async (executable, cwd) => {
    const output = await runOpencode(executable, cwd, null, ["session", "list", "--format", "json"]);
    const entries = (output.trim() ? JSON.parse(output) : []) as { id?: unknown; title?: unknown }[];
    for (const entry of entries) {
      if (typeof entry.id === "string" && String(entry.title) === ASK_TITLE) {
        await runOpencode(executable, cwd, null, ["session", "delete", entry.id]).catch(() => undefined);
      }
    }
  },
  sessions: opencodeSessionProvider,
  // The plugin sends the root session's id with every report.
  sessionIdOf: hookSessionId,
  resolveUrlPrefix: resolveOpencodeUrlPrefix,
  prepareSpawn: (_executable, cwd, paths) => {
    registerAgentDir(cwd, paths.agentDir);
    let env: Record<string, string> = {};
    try {
      env = writeOpencodePlugin(hostConfigDir(paths.storageRoot), paths.agentDir, cwd, HOST_TARGET, null);
    } catch (error) {
      // Costs turn marks, records and TET's system prompt, not the CLI — swallow (see prepareSpawn).
      console.error("[tet] could not write opencode's plugin:", error);
    }
    return Promise.resolve({
      args: [],
      // Defaults: a user's own OPENCODE_CONFIG_DIR or OPENCODE_TUI_CONFIG wins (spawnAgentProcess).
      env: { ...env, ...installTuiConfig(paths.storageRoot) }
    });
  },
  prepareSandboxSpawn: (cwd, paths, sandbox) => {
    try {
      // Its own config dir (a Linux bun install); records and rename requests stay agentDir's,
      // shared with host tabs.
      const configDir = sandboxConfigDir(paths.agentDir);
      const env = writeOpencodePlugin(configDir, paths.agentDir, cwd, SANDBOX_TARGET, sandbox);
      // Under the mounted dir: storageRoot's copy is not in the sandbox.
      for (const [key, file] of Object.entries(installTuiConfig(configDir))) {
        env[key] = SANDBOX_TARGET.embed(file);
      }
      // The sandbox is the safety boundary, as with Claude Code's kit
      // (--dangerously-skip-permissions). sbx's opencode kit does not set this itself (measured,
      // 0.42.1) — drop it once a kit does.
      return { args: ["--auto"], env };
    } catch (error) {
      console.error("[tet] could not write opencode's sandbox plugin:", error);
      return { args: [] };
    }
  },
  // Documented, not verified: skills in `~/.config/opencode/skills`, `~/.claude/skills`,
  // `~/.agents/skills`; `~/.config/opencode/plugins`; rules `~/.config/opencode/AGENTS.md`, else
  // `~/.claude/CLAUDE.md`. Its config directory (the user's providers in `opencode.json`) stays out;
  // auth is under `~/.local/share/opencode`. `~/.claude/skills` is left out although opencode reads
  // it: Claude's own folder goes to Claude's sandbox, the shared one to every agent.
  sandboxKnowledge: () => {
    const home = os.homedir();
    const rules = [
      { host: path.join(home, ".config", "opencode", "AGENTS.md"), target: `${SANDBOX_HOME}/.config/opencode/AGENTS.md` },
      { host: path.join(home, ".claude", "CLAUDE.md"), target: `${SANDBOX_HOME}/.claude/CLAUDE.md` }
    ].find((entry) => fs.existsSync(entry.host));
    return {
      skills: [{ host: path.join(home, ".config", "opencode", "skills"), target: `${SANDBOX_HOME}/.config/opencode/skills` }],
      plugins: [{ host: path.join(home, ".config", "opencode", "plugins"), target: `${SANDBOX_HOME}/.config/opencode/plugins` }],
      instructions: rules ? [rules] : []
    };
  },
  sharedSkillsTarget: `${SANDBOX_HOME}/.agents/skills`,
  // A raw byte count fires on blank repaints while opencode fetches its model list (measured,
  // 1.18.4). 20 is below the 164 non-ASCII bytes of the real frame and above blank repaints' 0.
  createIsSessionReady: () => createNonAsciiThresholdCheck(20),
  // Its TUI leaves at once (measured, 1.18.4: gone 213 ms after the byte).
  quitPresses: 1,
  // Its TUI takes the right click (it copies the selection).
  takesRightMouse: true,
  // With `"theme": "system"` (tui-config.ts).
  swapsBlueMagenta: true
};
