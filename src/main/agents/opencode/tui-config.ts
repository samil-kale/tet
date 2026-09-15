import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `"theme": "system"` is the only way opencode takes the terminal's colours (xterm's `--vscode-*`,
 * `src/renderer/terminal/theme.ts`); every other theme paints its own background.
 *
 * A tet file `OPENCODE_TUI_CONFIG` points at, layered over opencode's config; the user's `tui.json`
 * is never touched, and a user-set variable wins. One file for all repositories: `dir` is
 * storageRoot on the host, the mounted config dir in a sandbox.
 *
 * Another project's opencode may be reading it: renamed into place, and only when changed.
 */
export function installTuiConfig(dir: string): Record<string, string> {
  const file = path.join(dir, "opencode-tui.json");
  const contents = JSON.stringify({ $schema: "https://opencode.ai/tui.json", theme: "system" }, null, 2);
  try {
    if (readIfExists(file) !== contents) {
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, contents);
      fs.renameSync(temp, file);
    }
  } catch (error) {
    // opencode's own colours still work.
    console.error("[tet] could not write the opencode tui config:", error);
    return {};
  }
  return { OPENCODE_TUI_CONFIG: file };
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
