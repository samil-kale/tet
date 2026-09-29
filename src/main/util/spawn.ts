import { execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PLATFORM } from "./host-platform";

/** PATH's key in `env` — win32's `Path`; a key in another case would be a second variable. */
export function pathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

const WIN32_NATIVE_EXTENSIONS = [".exe", ".com"];
const WIN32_BATCH_EXTENSIONS = [".cmd", ".bat"];
const WIN32_EXTENSIONS = [...WIN32_NATIVE_EXTENSIONS, ...WIN32_BATCH_EXTENSIONS];

/**
 * What `executable` names, searched in its folder or else along PATH, and whether it is a batch
 * file: node-pty's CreateProcessW applies no PATHEXT and cannot launch a .cmd/.bat/.ps1 shim, so
 * only a native one is spawned directly. Every extension is tried per folder before the next
 * folder, as cmd.exe resolves a name — a `.cmd` earlier on PATH beats an `.exe` later, and a shim
 * put in front of a program is what runs. Undefined where nothing (or only a .ps1) resolves.
 */
function resolveWin32Executable(executable: string): { path: string; batch: boolean } | undefined {
  const pathDirs = (): string[] => (process.env.PATH ?? "").split(path.delimiter);
  const ext = path.extname(executable).toLowerCase();
  if (ext) {
    if (!WIN32_EXTENSIONS.includes(ext)) {
      return undefined;
    }
    // A bare `npm.cmd` is found along PATH too, or isCmdShim would read it in this process's folder
    // and miss the shim. Unfound, it stays the name, for CreateProcessW or cmd.exe to look up.
    const found = path.basename(executable) === executable ? pathDirs().map((dir) => path.join(dir, executable)).find((candidate) => fs.existsSync(candidate)) : undefined;
    return { path: found ?? executable, batch: WIN32_BATCH_EXTENSIONS.includes(ext) };
  }

  const dir = path.dirname(executable);
  const searchDirs = dir !== "." ? [dir] : pathDirs();
  for (const searchDir of searchDirs) {
    for (const extension of WIN32_EXTENSIONS) {
      const candidate = path.join(searchDir, path.basename(executable) + extension);
      if (fs.existsSync(candidate)) {
        return { path: candidate, batch: WIN32_BATCH_EXTENSIONS.includes(extension) };
      }
    }
  }
  return undefined;
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  /** The args are one escaped cmd.exe line: pass as `windowsVerbatimArguments` to child_process,
   *  joined with spaces to node-pty (which takes a string as the command line as is). */
  windowsVerbatimArguments?: true;
}

/** Every character cmd.exe gives a meaning, `^`-escaped. */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** The line of an npm, pnpm or yarn cmd-shim that runs the package: a script by its path beside the
 *  shim (`"%dp0%\…"`, `"%~dp0\…"`), then `%*`. Recognized by content, since a global shim
 *  (`%APPDATA%\npm`) lies outside cross-spawn's `node_modules\.bin`. */
const CMD_SHIM_LINE = /"%(?:dp0%|~dp0)[^"\r\n]*"[ \t]*%\*[ \t]*$/im;

function isCmdShim(file: string): boolean {
  try {
    return CMD_SHIM_LINE.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** One argument for a program behind cmd.exe: quoted by the C runtime's rules, then `^`-escaped, so
 *  `&`, `>` or `%VAR%` reach it literally. A shim parses its `%*` a second time, so there it is
 *  escaped twice:
 *  once, `a"&b` ends the quote cmd.exe sees and `&b` runs as a command. Only there — a batch file
 *  reading `%~1` itself keeps the second carets (Maven's `if "%~1" == "-f"`: a syntax error). */
function escapeCmdArgument(arg: string, shim: boolean): string {
  // Every backslash before a quote, or before the closing one, doubled: the C runtime halves a run.
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const escaped = quoted.replace(CMD_META_CHARS, "^$1");
  return shim ? escaped.replace(CMD_META_CHARS, "^$1") : escaped;
}

/** Where a command line goes, for every agent, shell and `sbx` spawn: on win32 a native executable directly, a shim or an
 *  unresolved name through cmd.exe; elsewhere unchanged. */
export function resolveCommand(executable: string, args: string[]): ResolvedCommand {
  if (PLATFORM.spawnsThroughCmd) {
    const resolved = resolveWin32Executable(executable);
    if (resolved && !resolved.batch) {
      return { command: resolved.path, args };
    }
    // Shim or unresolved: cmd.exe, not `shell: true`, which joins args unescaped. The whole line is
    // escaped as cross-spawn does it; `/s` strips only the outer quotes.
    const shim = resolved !== undefined && isCmdShim(resolved.path);
    const line = [executable.replace(CMD_META_CHARS, "^$1"), ...args.map((arg) => escapeCmdArgument(arg, shim))].join(" ");
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
  }
  return { command: executable, args };
}

/** Kills a process `resolveCommand` started, with its children: on win32 `kill()` would end only the
 *  cmd.exe in front of a shim, while the program keeps running (and its pipes open). */
export function killProcessTree(child: ChildProcess): void {
  if (PLATFORM.killsWithTaskkill && child.pid !== undefined) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    child.kill();
  }
}
