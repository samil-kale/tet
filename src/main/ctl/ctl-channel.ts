import * as crypto from "node:crypto";
import * as path from "node:path";
import { CONTROL_ENV } from "../../shared/ctl";
import { configureSandboxes } from "../sbx/sbx-status";
import { setControlEnv } from "../terminals/pty";
import { logError } from "../util/error-log";
import { writeLaunchers } from "./ctl-launcher";
import { findControlPort } from "./ctl-port";

/**
 * Readies the control channel before the first spawn: its token, its port, the `tet-ctl` launcher
 * on every tab's PATH, and what a sandbox needs to reach it. Each terminal gets only a token made
 * from this one for its own tab (ctl-token.ts); this one lives in this process only — never on
 * disk or a command line. `reuseToken` is the one a TET started from a tab of another hands on.
 */
export async function prepareControl(
  dataRoot: string,
  appDir: string,
  installed: boolean,
  reuseToken: string | undefined,
): Promise<{ token: string; port: number }> {
  const token = reuseToken || crypto.randomBytes(24).toString("base64url");
  const port = await findControlPort(dataRoot);
  // Installed, dist/ is in app.asar, unreadable outside electron; electron-builder.yml unpacks
  // the CLI.
  const cliPath = path.join(installed ? appDir.replace("app.asar", "app.asar.unpacked") : appDir, "tet-ctl.js");
  let binDir: string | undefined;
  try {
    binDir = writeLaunchers(dataRoot, cliPath);
  } catch (error) {
    // Not fatal: terminals then just lack `tet-ctl` on PATH.
    logError("could not write the tet-ctl launcher", error);
  }
  setControlEnv({ [CONTROL_ENV.port]: String(port), [CONTROL_ENV.token]: token }, binDir);
  // A sandbox cannot reach the data folder's launcher, so sbx.ts writes the bundle into it
  // (ensureSandboxLauncher).
  configureSandboxes(cliPath, port, dataRoot);
  return { token, port };
}
