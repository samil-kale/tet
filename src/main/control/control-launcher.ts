import * as fs from "node:fs";
import * as path from "node:path";
import { shellSingleQuote, writePosixScript } from "../script-text";
import { writeIfChanged } from "../write-if-changed";

/**
 * The `tet-ctl` launcher, rewritten into the data folder at every start (install and `npm start`
 * run from different places) and prepended to each pty's PATH in `spawnAgentProcess`, never
 * installed machine-wide. Runs the CLI with tet's own electron under `ELECTRON_RUN_AS_NODE`: a
 * `node` is not a given (Codex ships a native binary).
 */
export function writeLaunchers(dataRoot: string, cliPath: string): string {
  const binDir = path.join(dataRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const posix = path.join(binDir, "tet-ctl");
  if (process.platform === "win32") {
    // .cmd, not .ps1: cmd.exe finds only .cmd on PATH. Known limit: cmd expands a `%` in either
    // path. `setlocal`, or an interactive cmd.exe keeps ELECTRON_RUN_AS_NODE for every electron
    // app started there later.
    writeIfChanged(
      path.join(binDir, "tet-ctl.cmd"),
      `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cliPath}" %*\r\n`
    );
    // The POSIX one too: hooks run in the agent's shell, on win32 an MSYS bash, which never
    // resolves .cmd and rewrites `cmd.exe /c` to `C:\`. bash runs the extensionless shebang file;
    // PowerShell and cmd.exe resolve the .cmd via PATHEXT.
  }
  writePosixScript(
    posix,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(cliPath)} "$@"\n`
  );
  return binDir;
}
