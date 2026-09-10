import * as fs from "node:fs";
import * as path from "node:path";
import { shellSingleQuote, writePosixScript } from "../terminals/os-notify";

/**
 * The `tet-ctl` command a terminal finds on its PATH: one launcher per platform, written into
 * tet's own userData at every start (its paths move with every update) and prepended to every
 * pty's PATH in `spawnAgentProcess`, never installed machine-wide. It runs the bundled CLI with
 * tet's own electron binary under `ELECTRON_RUN_AS_NODE`: a `node` on the machine is not a given
 * (opencode and Codex ship as native binaries), the electron running tet is.
 */
export function writeLaunchers(userDataPath: string, cliPath: string): string {
  const binDir = path.join(userDataPath, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const posix = path.join(binDir, "tet-ctl");
  if (process.platform === "win32") {
    // A .cmd rather than a .ps1: cmd.exe finds only the former on PATH. Known limit: a `%` in
    // either path would be expanded by cmd — batch has no literal quoting.
    fs.writeFileSync(
      path.join(binDir, "tet-ctl.cmd"),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cliPath}" %*\r\n`
    );
    // And the POSIX one beside it, because a hook command is run by whichever shell the agent
    // picked: measured, Claude Code runs its hooks on win32 under `/usr/bin/bash`, where a bare
    // `tet-ctl` is `command not found` (MSYS resolves .exe and .com on PATH, never .cmd) and
    // `cmd.exe /c` is worse — MSYS rewrites the `/c` into `C:\` and cmd opens interactively,
    // banner and all, straight into the prompt the hook was reporting. An extensionless file
    // with a shebang is what all three observed hook shells agree on: bash runs this one,
    // PowerShell and cmd.exe keep resolving the .cmd through PATHEXT (both measured).
  }
  writePosixScript(
    posix,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(cliPath)} "$@"\n`
  );
  // Found on PATH means run directly, unlike the hook scripts that are handed to `sh`.
  fs.chmodSync(posix, 0o755);
  return binDir;
}
