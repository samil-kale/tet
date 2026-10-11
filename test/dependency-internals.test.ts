import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { IPty } from "node-pty";
import { spawnAgentProcess } from "../src/main/terminals/pty";
import { ROOT, tempDir } from "./helpers";

/** The private fields of dependencies TET reaches into (pty.ts's guardPtyInput, terminal-views.ts's
 *  releaseWebgl): both degrade quietly when a field is renamed, so an upgrade that renames one fails
 *  here instead. */

function installed(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, "node_modules", ...parts), "utf8");
}

describe("node-pty's Windows input pipe", () => {
  it("is still `_agent.inSocket`, which guardPtyInput puts an error listener on", () => {
    assert.match(installed("node-pty", "lib", "windowsTerminal.js"), /\._agent\s*=/);
    assert.match(installed("node-pty", "lib", "windowsPtyAgent.js"), /"inSocket"/);
  });

  it("has an error listener on a pty TET spawned, wherever it has one", () => {
    const spawned = spawnAgentProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
      cwd: tempDir("tet-pty-"),
      cols: 80,
      rows: 24,
    });
    try {
      const agent = (spawned as IPty & { _agent?: { inSocket?: { listenerCount(event: string): number } } })._agent;
      // POSIX has no `_agent`: node-pty guards its socket there.
      if (agent) {
        assert.ok((agent.inSocket?.listenerCount("error") ?? 0) > 0);
      }
    } finally {
      spawned.kill();
    }
  });
});

describe("the xterm WebGL addon's renderer", () => {
  for (const file of ["addon-webgl.js", "addon-webgl.mjs"]) {
    it(`still keeps its context and canvas as \`_renderer._gl\` and \`_renderer._canvas\` (${file})`, () => {
      const source = installed("@xterm", "addon-webgl", "lib", file);
      assert.match(source, /this\._renderer=/);
      assert.match(source, /this\._gl=/);
      assert.match(source, /this\._canvas=/);
    });
  }
});
