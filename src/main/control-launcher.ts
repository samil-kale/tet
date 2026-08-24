import * as fs from "node:fs";
import * as path from "node:path";
import { shellSingleQuote, writePosixScript } from "./os-notify";

/**
 * The `tet-ctl` command a terminal finds on its PATH: one launcher per platform, written into
 * tet's own userData at every start (the paths in it move with every update) and prepended to
 * every pty's PATH in `spawnAgentProcess` — never installed machine-wide.
 *
 * It runs the bundled CLI with tet's own electron binary under `ELECTRON_RUN_AS_NODE`, the way
 * VS Code's `code` does: a `node` on the machine is not a given (opencode and Codex ship as
 * native binaries too), the electron that is running tet is.
 */
export function writeLaunchers(userDataPath: string, cliPath: string): string {
  const binDir = path.join(userDataPath, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    // A .cmd rather than a .ps1: cmd.exe finds only the former on PATH, PowerShell and Git Bash
    // find both. Known limit: a `%` in either path would be expanded by cmd — there is no
    // literal quoting in batch, and neither an install path nor a user name has held one so far.
    fs.writeFileSync(
      path.join(binDir, "tet-ctl.cmd"),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cliPath}" %*\r\n`
    );
  } else {
    const file = path.join(binDir, "tet-ctl");
    writePosixScript(
      file,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(cliPath)} "$@"\n`
    );
    // Found on PATH means run directly, unlike the hook scripts that are handed to `sh`.
    fs.chmodSync(file, 0o755);
  }
  return binDir;
}
