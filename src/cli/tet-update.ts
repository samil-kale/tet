import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { errorMessage } from "../shared/errors";
import { processAlive, runningUpdater, updateLockPath } from "../shared/release";
import type { UpdateResult } from "../shared/release";

/**
 * Run after tet quits: `tet-update.js <pid> <version> <staged root> <install root> <result file>`.
 * Started detached by auto-update.ts under the *new* binary as node from its unpack folder — the
 * installed binary gets replaced, and win32 locks it (and node-pty's native files) until tet's
 * process is gone. Hence the wait first.
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

/** Written beside and renamed into place: the app may be starting and reading it. */
function writeResult(file: string, result: UpdateResult): void {
  writeFileAtomic.sync(file, JSON.stringify(result));
}

function install(pid: number, version: string, staged: string, root: string, resultFile: string): void {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (processAlive(pid) && Date.now() < deadline) {
    sleep(POLL_MS);
  }
  // Never under a running tet: on macOS a quit can leave a windowless process. The next start finds
  // the version again, and the next quit installs it.
  if (processAlive(pid)) {
    writeResult(resultFile, { version, ok: false, output: `tet (pid ${pid}) was still running after ${EXIT_WAIT_MS / 1000}s` });
    return;
  }

  // Complete beside the install before the install is touched: moving it aside and this into
  // place are two renames, and nothing ever removes the install. A tet started meanwhile holds
  // its TET.exe and app.asar open: removing the install under it once left just those two files.
  const fresh = `${root}.new`;
  try {
    fs.rmSync(fresh, { recursive: true, force: true });
    try {
      fs.renameSync(staged, fresh);
    } catch {
      // A rename cannot take the folder this process runs from on win32, nor cross a volume.
      fs.cpSync(staged, fresh, { recursive: true, verbatimSymlinks: true });
    }
  } catch (error) {
    fs.rmSync(fresh, { recursive: true, force: true });
    writeResult(resultFile, { version, ok: false, output: `could not copy ${version} beside ${root}: ${errorMessage(error)}` });
    return;
  }

  // Moved aside, not deleted, so a failure can put it back.
  const old = `${root}.old`;
  try {
    fs.rmSync(old, { recursive: true, force: true });
    retried(() => fs.renameSync(root, old));
  } catch (error) {
    fs.rmSync(fresh, { recursive: true, force: true });
    writeResult(resultFile, {
      version,
      ok: false,
      output: `could not move ${root} aside within ${RETRY_WINDOW_MS / 1000}s: ${errorMessage(error)}`
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
  const [pidArg, version, staged, root, resultFile] = process.argv.slice(2);
  const lockFile = updateLockPath(path.dirname(resultFile));
  try {
    install(Number(pidArg), version, staged, root, resultFile);
  } finally {
    if (runningUpdater(lockFile) === process.pid) {
      fs.rmSync(lockFile, { force: true });
    }
  }
}

main();
