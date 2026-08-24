import { createByteThresholdCheck } from "../../terminals/session-ready";
import type { AgentDefinition } from "../agent";
import { ensureServer, prepareOpencodeSpawn, runningServer, stopServer } from "./server";
import { openServerRegistry } from "./server-registry";
import { resolveOpencodeUrlPrefix } from "./session-urls";
import { opencodeSessionProvider } from "./sessions";

/** What a background question's session is called, so it can be found and removed again. */
const ASK_TITLE = "tet: project commands";

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
  cleanupAsk: async (executable, cwd) => {
    // The listing starts a server where none is up. One started here belongs to no
    // preparation, so it is ended here as well — left running, it would outlive the project.
    const running = await runningServer(executable, cwd);
    const server = running ?? (await ensureServer(executable, cwd));
    try {
      const sessions = await opencodeSessionProvider.list(executable, cwd);
      for (const session of sessions.filter((candidate) => candidate.title === ASK_TITLE)) {
        await opencodeSessionProvider.remove(executable, cwd, session.id).catch(() => undefined);
      }
    } finally {
      if (!running) {
        await stopServer(cwd, server);
      }
    }
  },
  prepareApp: openServerRegistry,
  sessions: opencodeSessionProvider,
  prepareSpawn: prepareOpencodeSpawn,
  resolveUrlPrefix: resolveOpencodeUrlPrefix,
  // `attach` has no splash — it opens with a 4-byte and a 19-byte frame — so a plain byte
  // count is what tells the first real redraw: the frames before it total ~530 bytes, the
  // redraw itself is one chunk of 0.6 KB to 7.4 KB. 800 sits between.
  createIsSessionReady: () => createByteThresholdCheck(800),
  // One: its TUI starts leaving immediately.
  quitPresses: 1,
  // Its TUI handles the right click itself (it copies the selection).
  takesRightMouse: true,
  // Observed with `"theme": "system"` (tui-config.ts); see the field's own doc.
  swapsBlueMagenta: true
};
