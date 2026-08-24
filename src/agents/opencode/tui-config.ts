import * as fs from "node:fs";
import * as path from "node:path";

/**
 * opencode ships a palette of its own and draws its TUI in it, background included, so its
 * terminal looks nothing like the window around it. `"theme": "system"` is its way of taking
 * the terminal's colours instead — the `--vscode-*` ones xterm was handed
 * (`src/renderer/terminal/theme.ts`) — and the only one: every other theme paints its own background.
 * Claude Code and Codex are told their theme differently (see their own agent folders).
 *
 * It goes in a file of tet's own that `OPENCODE_TUI_CONFIG` points at, layered on top of
 * whatever opencode already loaded; the user's `tui.json` is never read, written or replaced.
 * Set on the *terminal* rather than on the server, since under `attach` the TUI is what draws —
 * and passed as a default, so a user who sets that variable themselves keeps their own file
 * (see spawnAgentProcess).
 *
 * One file for every repository: nothing in it names one.
 */
export function installTuiConfig(storageRoot: string): Record<string, string> {
  const file = path.join(storageRoot, "opencode-tui.json");
  const contents = JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: "system" }, null, 2);
  try {
    fs.writeFileSync(file, contents);
  } catch (error) {
    // A TUI in opencode's own colours is still a working TUI — unlike the server, this is not
    // worth marking the agent unstartable over.
    console.error("[tet] could not write the opencode tui config:", error);
    return {};
  }
  return { OPENCODE_TUI_CONFIG: file };
}
