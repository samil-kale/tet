import * as fs from "node:fs";
import type { UpdateResult } from "../shared/release";

/**
 * The update, run once tet has quit: `tet-update.js <pid> <version> <staged root> <install root>
 * <result file>`. Started detached by the app's auto-update.ts under the *new* version's binary as
 * node, from the folder that version was unpacked into — never the installed binary, which is what
 * gets replaced, and which win32 keeps locked, like node-pty's native files, until tet's process is
 * gone. Hence the wait first.
 */

const EXIT_WAIT_MS = 60_000;
const POLL_MS = 250;
/** A handle outliving the process by a moment (a pty's console host) fails a rename with EBUSY. */
const ATTEMPTS = 5;
const RETRY_MS = 2000;

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

function retried(action: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      action();
      return;
    } catch (error) {
      if (attempt >= ATTEMPTS) {
        throw error;
      }
      sleep(RETRY_MS);
    }
  }
}

/** Beside the target and renamed into place: the app may be starting again and reading it. */
function writeResult(file: string, result: UpdateResult): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(result));
  fs.renameSync(temp, file);
}

function main(): void {
  const [pidArg, version, staged, root, resultFile] = process.argv.slice(2);
  const pid = Number(pidArg);
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (alive(pid) && Date.now() < deadline) {
    sleep(POLL_MS);
  }
  // Never under a tet that is still there: measured on macOS, a quit can leave the process
  // standing without a window, and its folder would be replaced under it. The version is found
  // again at its next start, and installed at its next quit.
  if (alive(pid)) {
    writeResult(resultFile, { version, ok: false, output: `tet (pid ${pid}) was still running after ${EXIT_WAIT_MS / 1000}s` });
    return;
  }

  // The installed folder is moved aside rather than deleted first, so a failure can put it back.
  const old = `${root}.old`;
  try {
    fs.rmSync(old, { recursive: true, force: true });
    retried(() => fs.renameSync(root, old));
  } catch (error) {
    writeResult(resultFile, { version, ok: false, output: `could not move ${root} aside: ${String(error)}` });
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
    let output = `could not put ${version} in place: ${String(error)}`;
    // Retried like the move aside, and never in the way of the result: a scanner holding a file
    // just copied must not leave the failure unreported.
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
    fs.rmSync(old, { recursive: true, force: true, maxRetries: ATTEMPTS });
  } catch {
    // Left for the next update's rmSync above; the new version is in place either way.
  }
}

main();
