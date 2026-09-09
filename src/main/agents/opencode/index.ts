import * as path from "node:path";
import { hostTarget, sandboxTarget } from "../../terminals/hook-target";
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
const OLD_ASK_TITLE = "tet: project commands";

/** The host's plugin directory, shared across repositories — see plugin.ts for why. */
function hostConfigDir(storageRoot: string): string {
  return path.join(storageRoot, "opencode-plugins");
}

/**
 * opencode is client/server inside, but tet runs it the way it runs Claude Code: the plain
 * `opencode` in each tab, its server a worker thread of that same process (measured: the
 * generated plugin loads in `src/cli/tui/worker.js`, and nothing listens on a port), and a
 * generated plugin reporting the turns, the sessions and taking the context in — see plugin.ts.
 * The same on the host and in an sbx sandbox; only the launcher differs. No `opencode serve`
 * of tet's own, no `attach`: the one thing that bought — a listing without a process — the
 * session records give for nothing (sessions.ts).
 */
export const opencodeAgent: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  executable: () => "opencode",
  versionArgs: ["--version"],
  installUrl: "https://opencode.ai/docs/",
  /*
   * Its own non-interactive mode: prints the reply and exits. It has no way to skip persisting
   * the session, so the run is titled and `cleanupAsk` deletes it again by that title — the
   * alternative, deleting whatever appeared while the question ran, would also catch a session
   * the user started themselves in the meantime.
   */
  askArgs: ["run", "--title", ASK_TITLE],
  // The question runs without the plugin (askAgent spawns with the machine's environment), so
  // it leaves no record: opencode's own listing finds it — a process each, affordable once
  // after a suggestion, never in a hot path.
  cleanupAsk: async (executable, cwd) => {
    const output = await runOpencode(executable, cwd, null, ["session", "list", "--format", "json"]);
    const entries = (output.trim() ? JSON.parse(output) : []) as { id?: unknown; title?: unknown }[];
    for (const entry of entries) {
      if (typeof entry.id === "string" && [ASK_TITLE, OLD_ASK_TITLE].includes(String(entry.title))) {
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
      env = writeOpencodePlugin(hostConfigDir(paths.storageRoot), paths.agentDir, cwd, "OpenCode", paths.notifications, paths.contextFile, hostTarget(), null);
      // One watch serves host and sandboxed tabs: the sandbox's plugin writes its markers into
      // the same agentDir, through the mount (unlike Claude's hooks, whose sandbox copy has a
      // marker dir of its own under sandboxHookDir).
      watchers.push(watchTurnMarkers(paths.agentDir, paths));
    } catch (error) {
      // A plugin that could not be written costs the turn marks, the records and the context —
      // not the CLI, which starts fine without it. Not a rejection: that would mark the whole
      // agent unstartable.
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
      const target = sandboxTarget();
      const env = writeOpencodePlugin(configDir, paths.agentDir, cwd, "OpenCode", paths.notifications, paths.contextFile, target, sandbox);
      // The tui config too goes under the mounted dir: storageRoot's copy is not in the sandbox.
      for (const [key, file] of Object.entries(installTuiConfig(configDir))) {
        env[key] = target.embed(file);
      }
      return { args: [], env };
    } catch (error) {
      console.error("[tet] could not write opencode's sandbox plugin:", error);
      return { args: [] };
    }
  },
  // See createNonAsciiThresholdCheck: a raw byte count fires mid-repaint of an empty screen
  // while opencode is still fetching its model list, well before its logo and prompt are
  // actually on screen (measured, 1.18.4). 20 sits comfortably below the 164 the real frame
  // always carries and above the 0 every blank repaint before it does.
  createIsSessionReady: () => createNonAsciiThresholdCheck(20),
  // One: its TUI starts leaving immediately (measured on the plain TUI, 1.18.4: gone 213 ms
  // after the byte).
  quitPresses: 1,
  // Its TUI handles the right click itself (it copies the selection).
  takesRightMouse: true,
  // Observed with `"theme": "system"` (tui-config.ts); see the field's own doc.
  swapsBlueMagenta: true
};
