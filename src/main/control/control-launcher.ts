import * as fs from "node:fs";
import * as path from "node:path";
import { shellSingleQuote, writePosixScript } from "../script-text";
import { writeIfChanged } from "../write-if-changed";

/**
 * The `tet-ctl` launcher, rewritten into the data folder at every start (install and `npm start`
 * run from different places) and prepended to each pty's PATH in `spawnAgentProcess`, never
 * installed machine-wide. Runs the CLI with tet's own electron under `ELECTRON_RUN_AS_NODE`: a
 * `node` is not a given (opencode and Codex ship native binaries).
 */
export function writeLaunchers(dataRoot: string, cliPath: string): string {
  const binDir = path.join(dataRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const posix = path.join(binDir, "tet-ctl");
  if (process.platform === "win32") {
    // .cmd, not .ps1: cmd.exe finds only .cmd on PATH. Known limit: cmd expands a `%` in either
    // path. `setlocal`, or an interactive cmd.exe keeps ELECTRON_RUN_AS_NODE for every electron
    // app started there later (measured).
    writeIfChanged(
      path.join(binDir, "tet-ctl.cmd"),
      `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cliPath}" %*\r\n`
    );
    // The POSIX one too: hooks run in the agent's shell. Measured: Claude Code on win32 uses
    // `/usr/bin/bash`, where MSYS never resolves .cmd, and `cmd.exe /c` has its `/c` rewritten to
    // `C:\`, opening an interactive cmd into the prompt. bash runs the extensionless shebang file;
    // PowerShell and cmd.exe still resolve the .cmd via PATHEXT (both measured).
  }
  writePosixScript(
    posix,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(cliPath)} "$@"\n`
  );
  return binDir;
}
