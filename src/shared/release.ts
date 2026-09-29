import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform } from "./platform";

/**
 * Shared by src/main/update/auto-update.ts, src/cli/tet-update.ts and the install scripts
 * (scripts/install.sh, scripts/install.ps1). One archive per platform and architecture on the tag's
 * GitHub Release (electron-builder.yml). The scripts keep their own copy of these names: they run
 * before tet is on the machine. A change to a name updates the scripts too.
 */

/** `<url>/latest` redirects to the newest tag; `<url>/download/v<version>/<asset>` is a file. */
export const RELEASES_URL = "https://github.com/samil-kale/tet/releases";

/** The archive name per electron-builder.yml's `artifactName`, or undefined where none is built. */
export function assetName(platform: Platform, arch: string): string | undefined {
  return arch === "x64" || arch === "arm64" ? `${platform.assetPrefix}-${arch}.${platform.assetExtension}` : undefined;
}

/** The folder an update replaces whole: the app bundle, else the executable's folder. */
export function installRoot(executable: string, platform: Platform): string {
  return platform.appBundle ? path.resolve(executable, "..", "..", "..") : path.dirname(executable);
}

/** The inverse of `installRoot`. */
export function rootExecutable(root: string, platform: Platform): string {
  return path.join(root, ...platform.executableInRoot);
}

/** The install root inside an unpacked archive's entry: the bundle within it, else the entry. */
export function rootIn(entry: string, platform: Platform): string {
  return platform.appBundle ? path.join(entry, "TET.app") : entry;
}

/** Where the app's resources are inside an install root. */
export function resourcesDir(root: string, platform: Platform): string {
  return platform.appBundle ? path.join(root, "Contents", "Resources") : path.join(root, "resources");
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

/**
 * The pid of the running src/cli/tet-update.ts, in `<update dir>/update.lock`: written by
 * auto-update.ts as it starts the updater, removed by the updater when done. While that process
 * lives, a tet started meanwhile leaves the update folder alone — the updater runs from it — and
 * reports its result only once written.
 */
export function updateLockPath(updateDir: string): string {
  return path.join(updateDir, "update.lock");
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Far past the updater's longest run (tet-update.ts: a minute's wait for tet to exit, then
 *  half-minute retry windows). An older lock outlived its updater — killed by a shutdown before its
 *  `finally` — and its pid may since name another process, which would hold every later tet back. */
const UPDATER_MAX_LIFE_MS = 10 * 60_000;

/** The lock's pid while that process lives; a crashed updater's lock counts as none. */
export function runningUpdater(lockFile: string): number | undefined {
  let pid: number;
  try {
    if (Date.now() - fs.statSync(lockFile).mtimeMs > UPDATER_MAX_LIFE_MS) {
      return undefined;
    }
    pid = Number(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return undefined;
  }
  return Number.isInteger(pid) && pid > 0 && processAlive(pid) ? pid : undefined;
}
