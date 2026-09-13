import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { launchArgs } from "../shared/launch";
import { installDesktopIcon } from "./shortcuts";

/**
 * `tet`: the command `npm install -g tet-ide` puts on PATH. It starts electron with the package
 * as the app and returns — the window outlives the terminal it was typed into. Bundled into
 * dist/tet.js, so the package root is one level up.
 *
 * `require("electron")` under plain node is the path of electron's binary, and since Electron 42
 * also what downloads that binary the first time: the package has no install script, so neither
 * does tet (an `--ignore-scripts` install starts the same). Required rather than imported, so
 * esbuild leaves it to the installed package.
 *
 * That first download is over 100 MB, and all electron says about it is "Downloading Electron
 * binary..." with a progress bar after 30 seconds (@electron/get). So the first start is announced
 * before it, the way nativefier warns before fetching electron: what is being fetched, why, and
 * that it happens once. The check is electron's own (`isInstalled` in its install.js): the binary
 * `path.txt` names under `dist/`.
 */

const PACKAGE_DIR = path.join(__dirname, "..");

function announceFirstStart(resolve: NodeJS.Require): void {
  const electronDir = path.dirname(resolve.resolve("electron/package.json"));
  const pathFile = path.join(electronDir, "path.txt");
  if (fs.existsSync(pathFile) && fs.existsSync(path.join(electronDir, "dist", fs.readFileSync(pathFile, "utf8")))) {
    return;
  }
  const { version } = resolve("electron/package.json") as { version: string };
  process.stdout.write(
    `tet: first start. Fetching Electron ${version} into ${electronDir} (over 100 MB, once) - this takes seconds to minutes depending on the connection.\n`
  );
}

function main(): void {
  const resolve = createRequire(__filename);
  announceFirstStart(resolve);
  const electronPath: string = resolve("electron");
  // The variable that turns electron into node: set in one of tet's own terminals (tet-ctl's
  // launcher) or anywhere else, it would start a node here instead of the app.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [...launchArgs(process.platform, PACKAGE_DIR), ...process.argv.slice(2)];
  const child = spawn(electronPath, args, {
    detached: true,
    stdio: "ignore",
    env
  });
  child.on("spawn", () => {
    child.unref();
    // Only once tet is on its way: whatever becomes of the script, it is not tet's start.
    if (process.platform === "win32") {
      try {
        installDesktopIcon(process.argv.slice(2), electronPath, PACKAGE_DIR);
      } catch (error) {
        process.stderr.write(`tet: could not set up the desktop icon (${String(error)})\n`);
      }
    }
    process.exit(0);
  });
  child.on("error", (error) => {
    process.stderr.write(`tet: could not start electron at ${electronPath}: ${error.message}\n`);
    process.exit(1);
  });
}

main();
