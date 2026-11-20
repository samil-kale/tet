import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { PLATFORM } from "../main/util/host-platform";
import { errorMessage } from "../shared/errors";
import { processAlive, runningUpdater, updateLockPath } from "../shared/release";
import type { UpdateResult } from "../shared/release";

/**
 * Run after TET quits:
 * `tet-update.js <pid> <version> <unpack root> <install root> <result file> <prepared root>`.
 * Started detached by auto-update.ts under the *new* binary as node from its unpack folder — the
 * installed binary gets replaced, and win32 locks it (and node-pty's native files) until TET's
 * process is gone. Hence the wait first. The prepared root is the version already copied whole
 * beside the install while TET ran, leaving only the two renames. The TET starting this is the older
 * version, so these arguments keep their places: the unpack root is read by nothing here.
 */

const EXIT_WAIT_MS = 60_000;
const POLL_MS = 250;
/**
 * A handle briefly outliving the process (a pty's console host) fails a rename with EBUSY, or on
 * win32 with EPERM: retried over a window of time, not a count of tries.
 */
const RETRY_WINDOW_MS = 30_000;
const RETRY_MS = 1000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retried(action: () => void): void {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  for (;;) {
    try {
      action();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      sleep(RETRY_MS);
    }
  }
}

interface RunningProgram {
  pid: number;
  executable: string;
}

const PROCESS_TABLE_TIMEOUT_MS = 20_000;

/**
 * The programs running from inside `root`, read from the process table as JSON; none where a
 * running program does not lock its folder, or where the table cannot be read.
 */
function runningIn(root: string): RunningProgram[] {
  if (!PLATFORM.locksRunningPrograms) {
    return [];
  }
  const script =
    "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | " +
    "ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; executable = $_.ExecutablePath } })";
  let rows: RunningProgram[];
  try {
    const output = execFileSync(PLATFORM.shellExecutable(process.env), PLATFORM.shellCommandArgs(script), {
      encoding: "utf8",
      windowsHide: true,
      timeout: PROCESS_TABLE_TIMEOUT_MS,
    });
    rows = JSON.parse(output) as RunningProgram[];
  } catch {
    return [];
  }
  const inside = (file: string): boolean => {
    const relative = path.relative(
      PLATFORM.pathsIgnoreCase ? root.toLowerCase() : root,
      PLATFORM.pathsIgnoreCase ? file.toLowerCase() : file,
    );
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  return rows.filter((row) => row.pid !== process.pid && inside(row.executable));
}

/** Ends what runs from inside `root`, so nothing holds a file of the folder about to be renamed. */
function endRunningIn(root: string): void {
  for (const { pid } of runningIn(root)) {
    try {
      process.kill(pid);
    } catch {
      // Gone already, or not ours to end: the rename's own retries and its error say what is left.
    }
  }
}

/** Written beside and renamed into place: the app may be starting and reading it. */
function writeResult(file: string, result: UpdateResult): void {
  writeFileAtomic.sync(file, JSON.stringify(result));
}

function install(pid: number, version: string, root: string, resultFile: string, fresh: string): void {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (processAlive(pid) && Date.now() < deadline) {
    sleep(POLL_MS);
  }
  // Never under a running TET: on macOS a quit can leave a windowless process. The next start finds
  // the version again, and the next quit installs it.
  if (processAlive(pid)) {
    writeResult(resultFile, { version, ok: false, output: `tet (pid ${pid}) was still running after ${EXIT_WAIT_MS / 1000}s` });
    return;
  }

  // Complete beside the install before the install is touched: moving it aside and this into
  // place are two renames, and nothing ever removes the install. A TET started meanwhile holds
  // its TET.exe and app.asar open, which removing the install under it would leave behind.
  // Checked before the install is moved aside, which a missing copy would only have to undo.
  if (!fs.existsSync(fresh)) {
    writeResult(resultFile, { version, ok: false, output: `${fresh} is missing` });
    return;
  }

  // Moved aside, not deleted, so a failure can put it back.
  const old = `${root}.old`;
  try {
    fs.rmSync(old, { recursive: true, force: true });
    endRunningIn(root);
    retried(() => fs.renameSync(root, old));
  } catch (error) {
    fs.rmSync(fresh, { recursive: true, force: true });
    const holders = runningIn(root)
      .map(({ pid, executable }) => `${pid} ${executable}`)
      .join("\n");
    writeResult(resultFile, {
      version,
      ok: false,
      output:
        `could not move ${root} aside within ${RETRY_WINDOW_MS / 1000}s: ${errorMessage(error)}` +
        (holders ? `\nstill running from it:\n${holders}` : ""),
    });
    return;
  }
  try {
    retried(() => fs.renameSync(fresh, root));
  } catch (error) {
    let output = `could not put ${version} in place: ${errorMessage(error)}`;
    try {
      retried(() => fs.renameSync(old, root));
    } catch (restoreError) {
      output += `\ncould not put ${old} back: ${errorMessage(restoreError)}`;
    }
    writeResult(resultFile, { version, ok: false, output });
    return;
  }
  writeResult(resultFile, { version, ok: true, output: "" });
  try {
    fs.rmSync(old, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Left for the next update's rmSync; the new version is in place.
  }
}

function main(): void {
  const [pidArg, version, , root, resultFile, prepared] = process.argv.slice(2);
  const lockFile = updateLockPath(path.dirname(resultFile));
  try {
    install(Number(pidArg), version, root, resultFile, prepared);
  } finally {
    if (runningUpdater(lockFile) === process.pid) {
      fs.rmSync(lockFile, { force: true });
    }
  }
}

main();
