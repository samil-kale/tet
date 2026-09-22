import * as fs from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { errorMessage } from "../shared/errors";
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
 * win32 with EPERM. Measured: five tries over 10s were not enough on a CI runner (the release of
 * 0.11.1 failed there), so the wait is a window, not a count of tries.
 */
const RETRY_WINDOW_MS = 30_000;
const RETRY_MS = 1000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

function main(): void {
  const [pidArg, version, staged, root, resultFile] = process.argv.slice(2);
  const pid = Number(pidArg);
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (alive(pid) && Date.now() < deadline) {
    sleep(POLL_MS);
  }
  // Never under a running tet: on macOS a quit can leave a windowless process (measured). The
  // next start finds the version again, and the next quit installs it.
  if (alive(pid)) {
    writeResult(resultFile, { version, ok: false, output: `tet (pid ${pid}) was still running after ${EXIT_WAIT_MS / 1000}s` });
    return;
  }

  // Moved aside, not deleted, so a failure can put it back.
  const old = `${root}.old`;
  try {
    fs.rmSync(old, { recursive: true, force: true });
    retried(() => fs.renameSync(root, old));
  } catch (error) {
    writeResult(resultFile, {
      version,
      ok: false,
      output: `could not move ${root} aside within ${RETRY_WINDOW_MS / 1000}s: ${errorMessage(error)}`
    });
    return;
  }
  try {
    try {
      fs.renameSync(staged, root);
    } catch {
      // A rename cannot take the folder this process runs from on win32, nor cross a volume.
      fs.cpSync(staged, root, { recursive: true, verbatimSymlinks: true });
    }
  } catch (error) {
    let output = `could not put ${version} in place: ${errorMessage(error)}`;
    // Retried, never blocking the result: a scanner holding a copied file must not hide the failure.
    try {
      retried(() => fs.rmSync(root, { recursive: true, force: true }));
      retried(() => fs.renameSync(old, root));
    } catch (restoreError) {
      output += `\ncould not put ${old} back: ${String(restoreError)}`;
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

main();
