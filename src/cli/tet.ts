import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { launchArgs } from "../shared/launch";

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

/**
 * macOS names the Dock entry and the menu bar after the bundle, and draws the bundle's icon: an
 * electron from npm is "Electron" with electron's icon. So the bundle inside the package is made
 * tet's — name and icon in place, then signed again ad hoc, since editing it breaks the signature
 * Apple Silicon insists on. Once per tet version (a marker in the bundle); an electron update
 * brings a fresh bundle without the marker. `sips`, `iconutil`, `plutil` and `codesign` are part
 * of every macOS. A failure costs the name, never the start.
 */
function brandMacBundle(electronPath: string, version: string): void {
  const bundle = path.resolve(electronPath, "..", "..", "..");
  const marker = path.join(bundle, "Contents", "Resources", "tet-bundle");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === version) {
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tet-bundle-"));
  try {
    const plist = path.join(bundle, "Contents", "Info.plist");
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
      execFileSync("plutil", ["-replace", key, "-string", "TET", plist], { stdio: "ignore" });
    }
    const iconset = path.join(work, "tet.iconset");
    fs.mkdirSync(iconset);
    const source = path.join(__dirname, "icon.png");
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
        const pixels = String(size * scale);
        execFileSync("sips", ["-z", pixels, pixels, source, "--out", path.join(iconset, name)], { stdio: "ignore" });
      }
    }
    const iconFile = execFileSync("plutil", ["-extract", "CFBundleIconFile", "raw", plist], { encoding: "utf8" }).trim();
    const icns = path.join(bundle, "Contents", "Resources", iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`);
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns], { stdio: "ignore" });
    // The marker before the signature: a file added to the bundle afterwards would break its seal.
    fs.writeFileSync(marker, version);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "ignore" });
  } catch (error) {
    fs.rmSync(marker, { force: true });
    process.stderr.write(`tet: could not name the app bundle, it shows as Electron (${String(error)})\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main(): void {
  const electronPath: string = createRequire(__filename)("electron");
  if (process.platform === "darwin") {
    const { version } = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
    brandMacBundle(electronPath, version);
  }
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
    process.exit(0);
  });
  child.on("error", (error) => {
    process.stderr.write(`tet: could not start electron at ${electronPath}: ${error.message}\n`);
    process.exit(1);
  });
}

main();
