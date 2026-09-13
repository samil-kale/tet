import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { launchArgs, userDataDir } from "../shared/launch";
import { installShortcuts } from "./shortcuts";

/**
 * `tet`: the command `npm install -g tet-ide` puts on PATH. It starts electron with the package
 * as the app and returns — the window outlives the terminal it was typed into. Bundled into
 * dist/tet.js, so the package root is one level up.
 *
 * `require("electron")` under plain node is the path of electron's binary, and since Electron 42
 * also what downloads that binary the first time: the package has no install script, so neither
 * does tet (an `--ignore-scripts` install starts the same). Required rather than imported, so
 * esbuild leaves it to the installed package.
 */

const PACKAGE_DIR = path.join(__dirname, "..");

function main(): void {
  const electronPath: string = createRequire(__filename)("electron");
  // The variable that turns electron into node: set in one of tet's own terminals (tet-ctl's
  // launcher) or anywhere else, it would start a node here instead of the app.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [...launchArgs(process.platform, PACKAGE_DIR, process.execPath), ...process.argv.slice(2)];
  const child = spawn(electronPath, args, {
    detached: true,
    stdio: "ignore",
    env
  });
  child.on("spawn", () => {
    child.unref();
    // Only once tet is on its way: whatever becomes of the shortcuts, it is not tet's start.
    try {
      const userData = userDataDir(process.argv.slice(2), process.env, process.platform, os.homedir());
      installShortcuts(userData, electronPath, PACKAGE_DIR, process.execPath);
    } catch (error) {
      process.stderr.write(`tet: could not set up the shortcuts (${String(error)})\n`);
    }
    process.exit(0);
  });
  child.on("error", (error) => {
    process.stderr.write(`tet: could not start electron at ${electronPath}: ${error.message}\n`);
    process.exit(1);
  });
}

main();
