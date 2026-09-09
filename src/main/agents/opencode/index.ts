import * as path from "node:path";
import { HOST_TARGET, SANDBOX_TARGET } from "../../terminals/hook-target";
import { watchTurnMarkers } from "../../terminals/marker-watch";
import { createNonAsciiThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { runOpencode } from "./cli";
import { sandboxConfigDir, writeOpencodePlugin } from "./plugin";
import { resolveOpencodeUrlPrefix } from "./session-urls";
import { opencodeSessionProvider, registerAgentDir } from "./sessions";
import { installTuiConfig } from "./tui-config";

/** What a background question's session is called, so it can be found and removed again. */
const ASK_TITLE = "tet: background question";

/** The host's plugin directory, shared across repositories — see plugin.ts for why. */
function hostConfigDir(storageRoot: string): string {
  return path.join(storageRoot, "opencode-plugins");
}

/**
 * opencode is client/server inside, but tet runs the plain `opencode` in each tab: its server is
 * a worker thread of that same process (measured: the generated plugin loads in
 * `src/cli/tui/worker.js`, and nothing listens on a port), and a generated plugin reports the
 * turns and sessions and takes the context in — see plugin.ts. The same on the host and in an sbx
 * sandbox; only the launcher differs. No `opencode serve` of tet's own, no `attach`.
 */
export const opencodeAgent: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  executable: () => "opencode",
  versionArgs: ["--version"],
  installUrl: "https://opencode.ai/docs/",
  /*
   * Its own non-interactive mode: prints the reply and exits. It has no way to skip persisting
   * the session, so the run is titled and `cleanupAsk` deletes it again by that title.
   */
  askArgs: ["run", "--title", ASK_TITLE],
  // The question runs without the plugin (askAgent spawns with the machine's environment), so it
  // leaves no record and opencode's own listing has to find it — a process each, affordable once.
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
  resolveUrlPrefix: resolveOpencodeUrlPrefix,
  prepareSpawn: (_executable, cwd, paths) => {
    registerAgentDir(cwd, paths.agentDir);
    let env: Record<string, string> = {};
    const watchers: (() => void)[] = [];
    try {
      env = writeOpencodePlugin(hostConfigDir(paths.storageRoot), paths.agentDir, cwd, "OpenCode", paths.notifications, paths.contextFile, HOST_TARGET, null);
      // One watch serves host and sandboxed tabs: the sandbox's plugin writes its markers into
      // the same agentDir, through the mount.
      watchers.push(watchTurnMarkers(paths.agentDir, paths));
    } catch (error) {
      // A plugin that could not be written costs the turn marks, the records and the context —
      // not the CLI. See prepareSpawn: swallow, never reject.
      console.error("[tet] could not write opencode's plugin:", error);
    }
    return Promise.resolve({
      args: [],
      // Passed as defaults, so a user who sets OPENCODE_CONFIG_DIR or OPENCODE_TUI_CONFIG
      // themselves keeps their own (see spawnAgentProcess).
      env: { ...env, ...installTuiConfig(paths.storageRoot) },
      dispose: () => watchers.forEach((stop) => stop())
    });
  },
  prepareSandboxSpawn: (cwd, paths, sandbox) => {
    try {
      // Its own config dir (a Linux bun install), but the markers, records and rename requests
      // are agentDir's own, shared with a host tab — a session is a session wherever it ran.
      const configDir = sandboxConfigDir(paths.agentDir);
      const env = writeOpencodePlugin(configDir, paths.agentDir, cwd, "OpenCode", paths.notifications, paths.contextFile, SANDBOX_TARGET, sandbox);
      // The tui config too goes under the mounted dir: storageRoot's copy is not in the sandbox.
      for (const [key, file] of Object.entries(installTuiConfig(configDir))) {
        env[key] = SANDBOX_TARGET.embed(file);
      }
      return { args: [], env };
    } catch (error) {
      console.error("[tet] could not write opencode's sandbox plugin:", error);
      return { args: [] };
    }
  },
  // See createNonAsciiThresholdCheck: a raw byte count fires mid-repaint of an empty screen while
  // opencode is still fetching its model list (measured, 1.18.4). 20 sits below the 164 non-ASCII
  // bytes the real frame always carries and above the 0 of every blank repaint before it.
  createIsSessionReady: () => createNonAsciiThresholdCheck(20),
  // One: its TUI starts leaving immediately (measured, 1.18.4: gone 213 ms after the byte).
  quitPresses: 1,
  // Its TUI handles the right click itself (it copies the selection).
  takesRightMouse: true,
  // Observed with `"theme": "system"` (tui-config.ts); see the field's own doc.
  swapsBlueMagenta: true
};
