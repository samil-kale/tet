import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as semver from "semver";
import { findControlPort } from "../src/main/control/control-server";
import { resolveCommand } from "../src/main/terminals/pty";
import { CONTROL_ENV } from "../src/shared/control";
import { NPM_PACKAGE } from "../src/shared/launch";
import type { UpdateResult } from "../src/shared/launch";
import { eventually, tetCtl } from "./helpers";

/**
 * What a user does with tet, on the platform this runs on: install the package from a registry,
 * start it with the `tet` command, let it find a newer version, quit, and start what the update
 * installed. The registry is a local verdaccio holding two builds of this very checkout — the
 * packed one and a copy one patch version up — so nothing is published anywhere.
 *
 * Only with TET_INSTALL_TEST=1 (the release workflow's install-test job): it packs the checkout,
 * fetches verdaccio and electron, and on Windows writes the Start menu entry, the desktop icon and
 * the toast name for the account running it. Needs a display, like app.test.ts.
 */

const ENABLED = process.env.TET_INSTALL_TEST === "1";
const ROOT = path.join(__dirname, "..");
const REGISTRY = "http://127.0.0.1:4873/";
const STARTUP_MS = 120_000;
const TOKEN = "install-test-token";

let work: string;
let prefix: string;
let userData: string;
let registry: ChildProcess | undefined;
let env: NodeJS.ProcessEnv;
let current: string;
let next: string;

function run(executable: string, args: string[], options: { cwd?: string } = {}): SpawnSyncReturns<string> {
  const { command, args: resolved } = resolveCommand(executable, args);
  return spawnSync(command, resolved, { cwd: options.cwd, env, encoding: "utf8", windowsHide: true });
}

function npm(args: string[], cwd?: string): string {
  const result = run("npm", args, { cwd });
  assert.equal(result.status, 0, `npm ${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function packageDir(): string {
  return process.platform === "win32"
    ? path.join(prefix, "node_modules", NPM_PACKAGE)
    : path.join(prefix, "lib", "node_modules", NPM_PACKAGE);
}

function installedVersion(): string {
  return (JSON.parse(fs.readFileSync(path.join(packageDir(), "package.json"), "utf8")) as { version: string }).version;
}

/** The `tet` command npm put into the prefix, started the way a user types it. */
function startTet(): void {
  const bin = process.platform === "win32" ? path.join(prefix, "tet.cmd") : path.join(prefix, "bin", "tet");
  const result = run(bin, [`--user-data-dir=${userData}`, "--allow-shell-only"]);
  assert.equal(result.status, 0, `tet\n${result.stdout}${result.stderr}`);
}

async function version(): Promise<{ version: string; pid: number } | undefined> {
  const answer = await tetCtl(["version"], {
    [CONTROL_ENV.port]: String(await findControlPort(userData)),
    [CONTROL_ENV.token]: TOKEN
  });
  return answer.status === 0 ? (answer.result as { version: string; pid: number }) : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The quit a user gives, per platform: closing the window, SIGTERM, Cmd+Q's Apple Event. */
function quit(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid)], { stdio: "ignore" });
  } else if (process.platform === "darwin") {
    spawnSync("osascript", ["-e", 'tell application id "com.github.Electron" to quit'], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGTERM");
  }
}

function kill(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

describe("tet installed from a registry, and updated", { skip: !ENABLED, timeout: 10 * 60_000 }, () => {
  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "tet-install-"));
    prefix = path.join(work, "prefix");
    userData = path.join(work, "user-data");
    const npmrc = path.join(work, "npmrc");
    fs.writeFileSync(npmrc, `registry=${REGISTRY}\n//127.0.0.1:4873/:_authToken=install-test\n`);
    // npm and tet alike read the registry from here: tet's update check through latest-version.
    env = { ...process.env, npm_config_userconfig: npmrc, npm_config_registry: REGISTRY, [CONTROL_ENV.token]: TOKEN };

    const packed = path.join(work, "packed");
    fs.mkdirSync(packed);
    npm(["pack", "--ignore-scripts", "--pack-destination", packed], ROOT);
    const [tarball] = fs.readdirSync(packed);
    current = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    next = semver.inc(current, "patch") as string;
    // The newer build is this one with its version raised: what changes is only what the update sees.
    const copy = path.join(work, "copy");
    fs.mkdirSync(copy);
    assert.equal(spawnSync("tar", ["-xzf", path.join(packed, tarball), "-C", copy]).status, 0, "tar");
    const manifest = path.join(copy, "package", "package.json");
    fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, "utf8")), version: next }, null, 2));
    npm(["pack", "--ignore-scripts", "--pack-destination", packed], path.join(copy, "package"));

    const storage = path.join(work, "registry");
    fs.mkdirSync(storage);
    fs.writeFileSync(
      path.join(storage, "config.yaml"),
      [
        "storage: ./storage",
        "auth:",
        "  htpasswd:",
        "    file: ./htpasswd",
        "    max_users: -1",
        "uplinks:",
        "  npmjs:",
        "    url: https://registry.npmjs.org/",
        "packages:",
        `  '${NPM_PACKAGE}':`,
        "    access: $all",
        "    publish: $anonymous",
        "  '**':",
        "    access: $all",
        "    proxy: npmjs",
        "log: { type: stdout, format: pretty, level: warn }",
        ""
      ].join("\n")
    );
    const { command, args } = resolveCommand("npx", ["-y", "verdaccio@6.10.3", "--config", "./config.yaml", "--listen", "127.0.0.1:4873"]);
    // The machine's own environment: verdaccio itself comes from the public registry, not from the
    // local one it is about to be.
    const log = fs.openSync(path.join(work, "registry.log"), "w");
    registry = spawn(command, args, { cwd: storage, stdio: ["ignore", log, log], windowsHide: true });
    await eventually(
      () => `the local registry answering\n${fs.readFileSync(path.join(work, "registry.log"), "utf8")}`,
      async () => {
        try {
          return (await fetch(`${REGISTRY}-/ping`)).ok;
        } catch {
          return false;
        }
      },
      STARTUP_MS
    );
    for (const name of fs.readdirSync(packed)) {
      npm(["publish", path.join(packed, name), "--ignore-scripts"]);
    }
  });

  after(async () => {
    const running = await version().catch(() => undefined);
    if (running) {
      kill(running.pid);
    }
    if (registry?.pid !== undefined) {
      kill(registry.pid);
    }
    // A pty's console host or the registry's files can be held a moment longer.
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  });

  it("installs with --ignore-scripts and starts through the tet command", async () => {
    npm(["install", "-g", "--ignore-scripts", `--prefix=${prefix}`, `${NPM_PACKAGE}@${current}`]);
    assert.equal(installedVersion(), current);
    startTet();
    await eventually("tet answering", async () => (await version())?.version === current, STARTUP_MS);
  });

  it("puts its Windows entries in place", { skip: process.platform !== "win32" }, async () => {
    const lnk = (dir: string): string => path.join(dir, "TET.lnk");
    const startMenu = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs");
    await eventually("the Start menu entry", () => fs.existsSync(lnk(startMenu)), 30_000);
    const desktop = path.join(os.homedir(), "Desktop");
    await eventually("the desktop icon", () => fs.existsSync(lnk(desktop)), 30_000);
    const key = spawnSync("reg", ["query", "HKCU\\Software\\Classes\\AppUserModelId\\com.samilkale.tet", "/v", "DisplayName"], {
      encoding: "utf8"
    });
    assert.match(key.stdout, /TET/, "the toasts' name in the registry");
  });

  it("finds the newer version, and installs it once tet has quit", async () => {
    const running = await version();
    assert.ok(running, "tet running");
    // The check runs at startup; the notice it leads to is what arms the update for the quit.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    quit(running.pid);
    await eventually("tet gone", () => !alive(running.pid), 60_000);
    const resultFile = path.join(userData, "update", "result.json");
    await eventually("the update's result", () => fs.existsSync(resultFile), 5 * 60_000);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as UpdateResult;
    assert.equal(result.ok, true, result.output);
    assert.equal(result.version, next);
    assert.equal(installedVersion(), next);
  });

  it("starts the updated version, which reports the update", async () => {
    startTet();
    await eventually("the new version answering", async () => (await version())?.version === next, STARTUP_MS);
    await eventually("the result reported", () => !fs.existsSync(path.join(userData, "update", "result.json")), 30_000);
  });
});
