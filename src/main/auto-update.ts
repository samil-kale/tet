import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import latestVersion from "latest-version";
import * as semver from "semver";
import { NPM_PACKAGE } from "../shared/launch";
import type { UpdateResult } from "../shared/launch";
import type { NoticeSeverity } from "../shared/types";
import { installPrefix, isWritable } from "./npm-install";

/** How often to look again after the check at startup. Nothing is urgent: an update installs only
 *  once tet quits. */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const MANUAL_COMMAND = `npm install -g ${NPM_PACKAGE}`;

/** The package tet runs from: main.js sits in its dist/. */
const PACKAGE_DIR = path.join(__dirname, "..");

type Notify = (severity: NoticeSeverity, message: string) => void;

/** The update found this session, for `installPendingUpdate` to run: the version and the prefix
 *  npm installs into. */
let pending: { version: string; prefix: string } | undefined;

function updateDir(): string {
  return path.join(app.getPath("userData"), "update");
}

function resultPath(): string {
  return path.join(updateDir(), "result.json");
}

/** What the last update left behind, reported once and deleted. */
function reportLastUpdate(notify: Notify): void {
  const file = resultPath();
  let result: UpdateResult;
  try {
    result = JSON.parse(fs.readFileSync(file, "utf8")) as UpdateResult;
  } catch {
    return;
  }
  fs.rmSync(file, { force: true });
  if (result.ok) {
    notify("info", `Updated to ${result.version}`);
  } else {
    console.error(`[tet] update to ${result.version} failed:\n${result.output}`);
    notify("error", `Update to ${result.version} failed, update with: ${MANUAL_COMMAND}`);
  }
}

/**
 * Only for tet started as an install (`--tet-installed`), never `npm start`. Asks
 * npm's registry at startup and every four hours; a newer version is announced once and, where
 * tet can install it by itself, installed when tet quits (`installPendingUpdate`) — never in the
 * middle of a session, a terminal tab being a live agent session. Where it cannot (pnpm, yarn,
 * bun, or a prefix that needs more rights), the notice carries the command instead.
 */
export function startAutoUpdate(installed: boolean, notify: Notify): void {
  if (!installed) {
    return;
  }
  const prefix = installPrefix(PACKAGE_DIR);
  const installable = prefix !== undefined && isWritable(path.dirname(PACKAGE_DIR)) ? prefix : undefined;
  let announced: string | undefined;

  const check = async () => {
    // Silent: an offline machine or a failing registry would otherwise put the same notice up
    // every four hours for something nobody asked for.
    // Asked of the registry npm itself installs from — the user's .npmrc or npm_config_registry,
    // a company mirror included — so what is announced is what the update can fetch.
    const latest = await latestVersion(NPM_PACKAGE).catch(() => undefined);
    if (!latest || !semver.valid(latest) || !semver.gt(latest, app.getVersion()) || latest === announced) {
      return;
    }
    announced = latest;
    if (installable) {
      pending = { version: latest, prefix: installable };
      notify("info", `Update ${latest} available, installs when you quit TET`);
    } else {
      notify("info", `Update ${latest} available, update with: ${MANUAL_COMMAND}`);
    }
  };

  reportLastUpdate(notify);
  void check();
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}

/**
 * Starts the update found this session, to run once this process is gone: called at the very end
 * of a quit, not a restart (a relaunched tet would hold the very files npm replaces). The script
 * is copied out of the package first, since npm replaces the package directory it came from.
 */
export function installPendingUpdate(): void {
  if (!pending) {
    return;
  }
  try {
    const dir = updateDir();
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "tet-update.js");
    fs.copyFileSync(path.join(__dirname, "tet-update.js"), script);
    // Whichever node the PATH has: npm is told the prefix, so it need not be the one that ran `tet`.
    // Not electron as node, since electron's own binary is among the files npm replaces.
    const child = spawn("node", [script, String(process.pid), pending.version, pending.prefix, resultPath()], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", (error) => console.error("[tet] could not start the update:", error));
    child.unref();
  } catch (error) {
    console.error("[tet] could not start the update:", error);
  }
}
