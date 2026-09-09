import * as fs from "node:fs";
import * as path from "node:path";

/**
 * opencode draws its TUI in a palette of its own, background included. `"theme": "system"` is the
 * only way to make it take the terminal's colours instead — the `--vscode-*` ones xterm was
 * handed (`src/renderer/terminal/theme.ts`); every other theme paints its own background.
 *
 * It goes in a file of tet's own that `OPENCODE_TUI_CONFIG` points at, layered over whatever
 * opencode already loaded; the user's `tui.json` is never read, written or replaced. Passed as a
 * default, so a user who sets that variable keeps their own file. One file for every repository:
 * `dir` is storageRoot for host tabs, a sandbox's own mounted config dir for a sandboxed one.
 */
export function installTuiConfig(dir: string): Record<string, string> {
  const file = path.join(dir, "opencode-tui.json");
  const contents = JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: "system" }, null, 2);
  try {
    fs.writeFileSync(file, contents);
  } catch (error) {
    // A TUI in opencode's own colours is still a working TUI.
    console.error("[tet] could not write the opencode tui config:", error);
    return {};
  }
  return { OPENCODE_TUI_CONFIG: file };
}
