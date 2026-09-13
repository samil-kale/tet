import * as path from "node:path";

/**
 * What the `tet` command (src/cli/tet.ts) and the app it starts agree on. tet is installed with
 * `npm install -g`, and nothing else installs it: `npm start` runs the same app without the
 * command in front.
 */

/** The package on npm — `tet` itself was taken. */
export const NPM_PACKAGE = "tet-ide";

/**
 * Handed to electron by the `tet` command, carrying the node that ran it. Its presence is how the
 * app knows it runs as an install rather than from a checkout, and the node is what the update
 * runs under once the app has quit (electron's own binary is among the files it replaces). An
 * argument rather than a variable: a variable would be inherited by every terminal, and a tet
 * started from one of those would take the outer one's value.
 */
export const NODE_ARG = "--tet-node=";

/** What electron is started with by the `tet` command, before the user's own arguments. */
export function launchArgs(platform: string, packageDir: string, nodePath: string): string[] {
  const args = [packageDir, `${NODE_ARG}${nodePath}`];
  // A package manager cannot give electron's chrome-sandbox the setuid root bit it wants, and
  // AppArmor on Ubuntu 24.04+ blocks the unprivileged fallback: electron aborts at launch without
  // this. What the renderer then runs without is Chromium's own process sandbox.
  if (platform === "linux") {
    args.push("--no-sandbox");
  }
  return args;
}

/**
 * What the update left for the next start to report (src/cli/tet-update.ts writes it, the app's
 * auto-update.ts reads and deletes it). `output` is the tail of npm's own output, for the log.
 */
export interface UpdateResult {
  version: string;
  ok: boolean;
  output: string;
}

/**
 * Where electron will put tet's userData, worked out by the `tet` command before electron runs:
 * the platform's per-user app data directory plus the `productName` from package.json, unless a
 * `--user-data-dir=` says otherwise (main.ts reads the same argument).
 */
export function userDataDir(argv: readonly string[], env: NodeJS.ProcessEnv, platform: string, home: string): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const explicit = argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
  if (explicit) {
    return paths.resolve(explicit);
  }
  if (platform === "win32") {
    return paths.join(env.APPDATA || paths.join(home, "AppData", "Roaming"), "TET");
  }
  if (platform === "darwin") {
    return paths.join(home, "Library", "Application Support", "TET");
  }
  return paths.join(env.XDG_CONFIG_HOME || paths.join(home, ".config"), "TET");
}

/** The node the `tet` command ran under, or undefined for a run without it (`npm start`). */
export function launcherNode(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(NODE_ARG))?.slice(NODE_ARG.length) || undefined;
}
