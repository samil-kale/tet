import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app, net } from "electron";
import { NPM_PACKAGE } from "../shared/launch";
import type { UpdateResult } from "../shared/launch";
import type { NoticeSeverity } from "../shared/types";
import { installPrefix, isNewerVersion, isWritable } from "./npm-install";

/** How often to look again after the check at startup. Nothing is urgent: an update installs only
 *  once tet quits. */
const CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const MANUAL_COMMAND = `npm install -g ${NPM_PACKAGE}`;

/** The package tet runs from: main.js sits in its dist/. */
const PACKAGE_DIR = path.join(__dirname, "..");

type Notify = (severity: NoticeSeverity, message: string) => void;

/** Set by `startAutoUpdate`: the node to run the update under and the version it installs. */
let node: string | undefined;
let pendingVersion: string | undefined;

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

async function latestVersion(): Promise<string | undefined> {
  const response = await net.fetch(LATEST_URL);
  if (!response.ok) {
    return undefined;
  }
  const { version } = (await response.json()) as { version?: unknown };
  return typeof version === "string" ? version : undefined;
}

/**
 * Only for tet started by its `tet` command (the node it passes along), never `npm start`. Asks
 * npm's registry at startup and every four hours; a newer version is announced once and, where
 * tet can install it by itself, installed when tet quits (`installPendingUpdate`) — never in the
 * middle of a session, a terminal tab being a live agent session. Where it cannot (pnpm, yarn,
 * bun, or a prefix that needs more rights), the notice carries the command instead.
 */
export function startAutoUpdate(launcherNode: string | undefined, notify: Notify): void {
  if (!launcherNode) {
    return;
  }
  const prefix = installPrefix(PACKAGE_DIR);
  const canInstall = prefix !== undefined && isWritable(path.dirname(PACKAGE_DIR));
  let announced: string | undefined;

  const check = async () => {
    // Silent: an offline machine or a failing registry would otherwise put the same notice up
    // every four hours for something nobody asked for.
    const latest = await latestVersion().catch(() => undefined);
    if (!latest || !isNewerVersion(latest, app.getVersion()) || latest === announced) {
      return;
    }
    announced = latest;
    if (canInstall) {
      node = launcherNode;
      pendingVersion = latest;
      notify("info", `Update ${latest} available, installs when you quit TET`);
    } else {
      notify("info", `Update ${latest} available, update with: ${MANUAL_COMMAND}`);
    }
  };

  // After the first check rather than right away: the window is still loading at this point, and
  // a notice sent before it listens is lost.
  void check().finally(() => reportLastUpdate(notify));
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}

/**
 * Starts the update found this session, to run once this process is gone: called at the very end
 * of a quit, not a restart (a relaunched tet would hold the very files npm replaces). The script
 * is copied out of the package first, since npm replaces the package directory it came from.
 */
export function installPendingUpdate(): void {
  if (!node || !pendingVersion) {
    return;
  }
  const prefix = installPrefix(PACKAGE_DIR);
  if (!prefix) {
    return;
  }
  try {
    const dir = updateDir();
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "tet-update.js");
    fs.copyFileSync(path.join(__dirname, "tet-update.js"), script);
    const child = spawn(node, [script, String(process.pid), pendingVersion, prefix, resultPath()], {
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
