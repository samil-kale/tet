import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { NPM_PACKAGE } from "../shared/launch";
import type { UpdateResult } from "../shared/launch";

/**
 * The update, run once tet has quit: `node tet-update.js <pid> <version> <prefix> <result file>`.
 * Started detached by the app's auto-update.ts from a copy outside the package, under the node
 * the `tet` command ran with — never electron's own binary, which is among the files npm
 * replaces, and which win32 keeps locked, like node-pty's native files, until tet's process is
 * gone. Hence the wait first.
 */

const EXIT_WAIT_MS = 60_000;
const POLL_MS = 250;
/** A handle outliving the process by a moment (a pty's console host) fails npm with EBUSY. */
const ATTEMPTS = 3;
const RETRY_MS = 3000;
const OUTPUT_TAIL = 4000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: there, only not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * npm itself, run by this node without a shell: `npm-cli.js` sits beside every node that ships
 * npm (`node_modules/npm` next to node.exe on win32, `../lib/node_modules/npm` elsewhere). Only
 * where it is not found does `npm` go through PATH, and on win32 through cmd.exe, its `npm.cmd`
 * being a shim.
 */
function npmCommand(args: string[]): { command: string; args: string[] } {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  if (cli) {
    return { command: process.execPath, args: [cli, ...args] };
  }
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm", ...args] };
  }
  return { command: "npm", args };
}

/** Beside the target and renamed into place: the app may be starting again and reading it. */
function writeResult(file: string, result: UpdateResult): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(result));
  fs.renameSync(temp, file);
}

function main(): void {
  const [pidArg, version, prefix, resultFile] = process.argv.slice(2);
  const pid = Number(pidArg);
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (alive(pid) && Date.now() < deadline) {
    sleep(POLL_MS);
  }

  // No install scripts: electron downloads its binary on first use and node-pty loads its
  // prebuilt files directly, so none are needed — and none run with the user's rights unasked.
  const { command, args } = npmCommand(["install", "-g", "--ignore-scripts", `--prefix=${prefix}`, `${NPM_PACKAGE}@${version}`]);
  let output = "";
  let ok = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt++) {
    if (attempt > 1) {
      sleep(RETRY_MS);
    }
    const run = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
    output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? String(run.error) : ""}`;
    ok = run.status === 0;
  }
  if (ok) {
    // electron fetches its binary on first use, and the install left the new copy without one:
    // fetched here, since tet's Windows shortcuts start that binary directly (shortcuts.ts).
    const packageDir =
      process.platform === "win32"
        ? path.join(prefix, "node_modules", NPM_PACKAGE)
        : path.join(prefix, "lib", "node_modules", NPM_PACKAGE);
    const fetch = spawnSync(process.execPath, ["-e", "require(process.argv[1])", path.join(packageDir, "node_modules", "electron")], {
      encoding: "utf8",
      windowsHide: true
    });
    output += `${fetch.stdout ?? ""}${fetch.stderr ?? ""}`;
  }
  writeResult(resultFile, { version, ok, output: output.slice(-OUTPUT_TAIL) });
}

main();
