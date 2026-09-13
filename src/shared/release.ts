import * as path from "node:path";

/**
 * What the app's update (src/main/auto-update.ts), the update run after a quit
 * (src/cli/tet-update.ts) and the install scripts (scripts/install.sh, scripts/install.ps1) agree
 * on. tet ships as one archive per platform and architecture on the GitHub Release of its tag,
 * built by electron-builder.yml; the scripts carry their own copy of these names, being run
 * before any of tet is on the machine.
 */

/** Where the releases are: `<url>/latest` redirects to the newest one's tag, and
 *  `<url>/download/v<version>/<asset>` is a file of it. */
export const RELEASES_URL = "https://github.com/samil-kale/tet/releases";

/**
 * The archive for a platform and architecture, as electron-builder.yml's `artifactName` names it,
 * or undefined where none is built.
 */
export function assetName(platform: string, arch: string): string | undefined {
  if (arch !== "x64" && arch !== "arm64") {
    return undefined;
  }
  switch (platform) {
    case "win32":
      return `TET-win-${arch}.zip`;
    case "darwin":
      return `TET-mac-${arch}.tar.gz`;
    case "linux":
      return `TET-linux-${arch}.tar.gz`;
    default:
      return undefined;
  }
}

/** The line a user runs to install tet by hand, the README's own. */
export function installCommand(platform: string): string {
  return platform === "win32"
    ? "irm https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.ps1 | iex"
    : "curl -fsSL https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.sh | sh";
}

/**
 * The folder an install replaces as a whole, off its executable: the app bundle on macOS
 * (`TET.app/Contents/MacOS/TET`), the folder holding the executable elsewhere.
 */
export function installRoot(executable: string): string {
  return process.platform === "darwin" ? path.resolve(executable, "..", "..", "..") : path.dirname(executable);
}

/** The executable inside an install root, the other way round from `installRoot`. */
export function rootExecutable(root: string): string {
  switch (process.platform) {
    case "win32":
      return path.join(root, "TET.exe");
    case "darwin":
      return path.join(root, "Contents", "MacOS", "TET");
    default:
      return path.join(root, "tet");
  }
}

/**
 * What the update left for the next start to report (src/cli/tet-update.ts writes it, the app's
 * auto-update.ts reads and deletes it). `output` says what went wrong, for the log.
 */
export interface UpdateResult {
  version: string;
  ok: boolean;
  output: string;
}
