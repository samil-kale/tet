import * as path from "node:path";

/**
 * Shared by src/main/auto-update.ts, src/cli/tet-update.ts and the install scripts
 * (scripts/install.sh, scripts/install.ps1). One archive per platform and architecture on the tag's
 * GitHub Release (electron-builder.yml). The scripts keep their own copy of these names: they run
 * before tet is on the machine. A change to a name updates the scripts too.
 */

/** `<url>/latest` redirects to the newest tag; `<url>/download/v<version>/<asset>` is a file. */
export const RELEASES_URL = "https://github.com/samil-kale/tet/releases";

/** The archive name per electron-builder.yml's `artifactName`, or undefined where none is built. */
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

/** The README's manual install line. */
export function installCommand(platform: string): string {
  return platform === "win32"
    ? "irm https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.ps1 | iex"
    : "curl -fsSL https://raw.githubusercontent.com/samil-kale/tet/development/scripts/install.sh | sh";
}

/** The folder an update replaces whole: the app bundle on macOS, the executable's folder elsewhere. */
export function installRoot(executable: string): string {
  return process.platform === "darwin" ? path.resolve(executable, "..", "..", "..") : path.dirname(executable);
}

/** The inverse of `installRoot`. */
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
 * The update's outcome for the next start: written by src/cli/tet-update.ts, read and deleted by
 * auto-update.ts. `output` is what went wrong, for the log.
 */
export interface UpdateResult {
  version: string;
  ok: boolean;
  output: string;
}
