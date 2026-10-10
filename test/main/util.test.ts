import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { LINUX, MAC, WINDOWS } from "../../src/shared/platform";
import { PLATFORM } from "../../src/main/util/host-platform";
import { shellSingleQuote } from "../../src/main/util/generated-file";
import { onDisk, openInside, relativeInside, removeInside } from "../../src/main/util/path-inside";
import { sameSet } from "../../src/main/util/same-set";
import { killProcessTree, resolveCommand } from "../../src/main/util/process";
import { eventually, processAlive, tempDir } from "../helpers";
import { isExecutableFile, isOpenableUrl } from "../../src/main/util/shell-open";
import { serving, type UtilityResponse } from "../../src/main/util/utility-host";
import { directoryMissing } from "../../src/main/util/watch-dir";

/** util/: spawning, quoting, paths, what the shell may open, a module served to another process. */

describe("a directory removed outside TET", () => {
  it("detects an absent folder and a parent replaced by a file", () => {
    const root = tempDir("tet-directory-");
    assert.equal(directoryMissing(root), false);
    const folder = path.join(root, "repository");
    assert.equal(directoryMissing(folder), true);
    fs.writeFileSync(folder, "a file");
    assert.equal(directoryMissing(folder), true);
    assert.equal(directoryMissing(path.join(folder, "repository")), true);
  });

  it("keeps a directory when the filesystem cannot answer", (t) => {
    const nodeFs = createRequire(__filename)("node:fs") as typeof fs;
    for (const code of ["EACCES", "EPERM", "EIO"]) {
      const stat = t.mock.method(nodeFs, "statSync", () => {
        throw Object.assign(new Error("The directory cannot be read"), { code });
      });
      assert.equal(directoryMissing("repository"), false);
      stat.mock.restore();
    }
  });
});

describe("resolveCommand", () => {
  /** Runs `program` as TET spawns it: resolved, no shell. */
  const runResolved = (program: string, args: string[], cwd: string) => {
    const resolved = resolveCommand(program, args);
    return spawnSync(resolved.command, resolved.args, {
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      cwd,
    });
  };

  it("spawns a native executable directly and routes a shim through cmd.exe", { skip: !PLATFORM.spawnsThroughCmd && "win32 only" }, () => {
    assert.deepEqual(resolveCommand("C:\\tools\\run.exe", ["-v"]), { command: "C:\\tools\\run.exe", args: ["-v"] });
    assert.deepEqual(resolveCommand("C:\\tools\\run.cmd", ["-v"]), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\tools\\run.cmd ^"-v^""'],
      windowsVerbatimArguments: true,
    });
  });

  it("hands every character to a shim literally, through cmd.exe", { skip: !PLATFORM.spawnsThroughCmd && "win32 only" }, () => {
    // A global npm shim's shape (cmd-shim), in a folder whose name cmd.exe would otherwise split and
    // group; node by its path, where cmd-shim looks beside the shim or on PATH.
    const dir = tempDir("tet shim (x)-");
    const script = path.join(dir, "argv.js");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const shim = path.join(dir, "echo-args.cmd");
    fs.writeFileSync(
      shim,
      "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n" +
        `SET "_prog=${process.execPath}"\r\n` +
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\argv.js" %*\r\n',
    );
    const args = [
      // A quote cmd.exe sees as closing, then an operator: the shim's `%*` parses the line again.
      // First, since an argument with an odd count of quotes (`a\"b`) would hide what follows.
      'a"&echo INJECTED&"b',
      'a">out.txt"',
      '{"k": 1}',
      "%VAR%",
      "plain",
      "",
      "a b",
      "a&b",
      "a>b",
      "a|b",
      "%PATH%",
      "a^b",
      'say "hi"',
      "(x)",
      "!x!",
      "C:\\dir\\",
      'a\\"b',
      "x;y,z",
      "ä€",
      // Runs of backslashes before a quote and at the end, each one halved by the C runtime.
      "C:\\out\\\\",
      'a\\\\"b',
      "x\\\\\\",
      'a\\\\\\"b',
    ];
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      // The shim by its path, and by a bare name found on PATH, with its extension or without.
      for (const program of [shim, "echo-args", "echo-args.cmd"]) {
        const run = runResolved(program, args, dir);
        assert.deepEqual(JSON.parse(run.stdout), args, `${program}: ${run.stdout} ${run.stderr}`);
      }
    } finally {
      process.env.PATH = originalPath;
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ["argv.js", "echo-args.cmd"], "nothing redirected into a file");
  });

  it("hands a batch file reading its own arguments each one once escaped", { skip: !PLATFORM.spawnsThroughCmd && "win32 only" }, () => {
    // Maven's `mvn.cmd` shape: `%~1` compared in an `if`, where a second escape's carets are a
    // syntax error ("[TET] mvn exited with code 255").
    const dir = tempDir("tet batch (x)-");
    const script = path.join(dir, "argv.js");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const batch = path.join(dir, "mvn.cmd");
    fs.writeFileSync(
      batch,
      '@ECHO off\r\nIF "%~1" == "-f" (SET "kind=file") ELSE (SET "kind=other")\r\n' + `"${process.execPath}" "${script}" %kind% %*\r\n`,
    );
    for (const [args, kind] of [
      [["process-classes", "exec:java", "a b"], "other"],
      [["-f", "pom.xml"], "file"],
    ] as const) {
      const run = runResolved(batch, [...args], dir);
      assert.equal(run.status, 0, `${run.stdout} ${run.stderr}`);
      assert.deepEqual(JSON.parse(run.stdout), [kind, ...args]);
    }
  });

  it("finds a native executable named by its path without an extension", { skip: !PLATFORM.spawnsThroughCmd && "win32 only" }, () => {
    const dir = tempDir("tet-native-");
    fs.writeFileSync(path.join(dir, "build.exe"), "");
    assert.deepEqual(resolveCommand(path.join(dir, "build"), ["-v"]), { command: path.join(dir, "build.exe"), args: ["-v"] });
  });

  it("kills the program behind a shim along with its cmd.exe", { skip: !PLATFORM.killsWithTaskkill && "win32 only" }, async () => {
    const dir = tempDir("tet-kill-");
    const pidFile = path.join(dir, "pid");
    const script = path.join(dir, "wait.js");
    fs.writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const shim = path.join(dir, "wait.cmd");
    fs.writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const resolved = resolveCommand(shim, []);
    const child = spawn(resolved.command, resolved.args, {
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      stdio: "ignore",
    });
    await eventually("the program started", () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "", 10_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    killProcessTree(child);
    await eventually("the program behind the shim exited", () => !processAlive(pid), 10_000);
  });

  it("takes a name's first folder on PATH, its extension second", { skip: !PLATFORM.spawnsThroughCmd && "win32 only" }, () => {
    // A shim put in front of an installed program: cmd.exe resolves per folder, every PATHEXT
    // extension before the next folder, so the earlier .cmd runs and not the later .exe.
    const dir = tempDir("tet-path-");
    const [first, second] = [path.join(dir, "first"), path.join(dir, "second")];
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "tool.cmd"), "@ECHO off\r\n");
    fs.writeFileSync(path.join(second, "tool.exe"), "");
    const originalPath = process.env.PATH;
    process.env.PATH = [first, second].join(path.delimiter);
    try {
      assert.equal(resolveCommand("tool", []).command, "cmd.exe", "the .cmd in the first folder");
      process.env.PATH = [second, first].join(path.delimiter);
      assert.equal(resolveCommand("tool", []).command, path.join(second, "tool.exe"), "the .exe where its folder comes first");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("changes nothing elsewhere", { skip: PLATFORM.spawnsThroughCmd && "not win32" }, () => {
    assert.deepEqual(resolveCommand("npm", ["-v"]), { command: "npm", args: ["-v"] });
  });
});

describe("the quoting helpers", () => {
  it("make any value one literal word in their shell", () => {
    assert.equal(shellSingleQuote("it's $HOME"), `'it'\\''s $HOME'`);
  });

  it("double every quote PowerShell ends a single-quoted path at, typographic ones too", () => {
    assert.equal(WINDOWS.shellQuotePath("C:\\a\\O'Brien’s ‘x’ ‚y‛.txt"), "'C:\\a\\O''Brien’’s ‘‘x’’ ‚‚y‛‛.txt'");
    assert.equal(WINDOWS.shellQuotePath("C:\\a\\plain.txt"), "C:\\a\\plain.txt");
  });
});

describe("a path inside a root", () => {
  const root = path.join(os.tmpdir(), "tet-root");

  it("is answered relative to the root", () => {
    assert.equal(relativeInside(root, path.join(root, "src", "a.ts")), path.join("src", "a.ts"));
  });

  it("counts a name that only starts with two dots as inside", () => {
    assert.equal(relativeInside(root, path.join(root, "..env")), "..env");
  });

  it("leaves out the root itself, its parent and its siblings", () => {
    assert.equal(relativeInside(root, root), undefined);
    assert.equal(relativeInside(root, path.dirname(root)), undefined);
    assert.equal(relativeInside(root, path.join(path.dirname(root), "other", "a.ts")), undefined);
  });
});

describe("a file opened or removed only inside a root", () => {
  /** A root holding `a.txt` and a link (a junction on win32, where a file symlink needs developer
   *  mode) to a folder outside holding `secret.txt`. */
  function linkedRoot(): { root: string; outside: string } {
    const root = tempDir("tet-inside-");
    const outside = tempDir("tet-outside-");
    fs.writeFileSync(path.join(root, "a.txt"), "inside");
    fs.writeFileSync(path.join(outside, "secret.txt"), "host");
    fs.symlinkSync(outside, path.join(root, "leak"), "junction");
    return { root, outside };
  }

  it("opens a file inside", async () => {
    const { root } = linkedRoot();
    const handle = await openInside(root, path.join(root, "a.txt"), "r");
    try {
      assert.equal(await handle.readFile("utf8"), "inside");
    } finally {
      await handle.close();
    }
  });

  it("refuses a file reached through a link out of the root, before writing to it", async () => {
    const { root, outside } = linkedRoot();
    await assert.rejects(
      openInside(root, path.join(root, "leak", "secret.txt"), fs.constants.O_WRONLY | fs.constants.O_APPEND),
      /leads outside/,
    );
    await assert.rejects(openInside(root, path.join(root, "leak"), "r"), /leads outside/, "a folder is no file");
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "host");
  });

  it("creates nothing through a linked folder", async () => {
    const { root, outside } = linkedRoot();
    await assert.rejects(openInside(root, path.join(root, "leak", "new.txt"), "wx"), /leads outside/);
    assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
  });

  it("removes inside, refuses through a link and resolves where the folder is gone", async () => {
    const { root, outside } = linkedRoot();
    await removeInside(root, path.join(root, "a.txt"));
    assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    await assert.rejects(removeInside(root, path.join(root, "leak", "secret.txt")), /leads outside/);
    assert.equal(fs.existsSync(path.join(outside, "secret.txt")), true);
    await removeInside(root, path.join(root, "gone", "a.txt"));
  });
});

describe("what a ctrl-click hands the OS", () => {
  it("opens web and mail links only", () => {
    for (const url of ["https://example.com/a?b=c", "http://localhost:3000", "mailto:someone@example.com"]) {
      assert.equal(isOpenableUrl(url), true, url);
    }
    for (const url of ["file:///C:/Windows/System32/calc.exe", "ms-msdt://x", "vscode://file/a", "javascript://%0aalert(1)", "not a url"]) {
      assert.equal(isOpenableUrl(url), false, url);
    }
  });

  it("counts a program by its extension on Windows, and by its executable bit elsewhere", () => {
    for (const name of ["setup.EXE", "run.bat", "run.cmd", "a.ps1", "a.vbs", "a.js", "a.msi", "a.lnk"]) {
      assert.equal(isExecutableFile(path.join("dir", name), 0o644, WINDOWS), true, name);
    }
    assert.equal(isExecutableFile("notes.txt", 0o755, WINDOWS), false, "Windows has no executable bit");
    assert.equal(isExecutableFile("build", 0o755, LINUX), true);
    assert.equal(isExecutableFile("build.sh", 0o644, LINUX), true);
    assert.equal(isExecutableFile("app.desktop", 0o644, LINUX), true);
    assert.equal(isExecutableFile("run.command", 0o644, MAC), true);
    assert.equal(isExecutableFile("notes.txt", 0o644, MAC), false);
  });
});

describe("a path in on-disk spelling", () => {
  it("is the folder's real path where it exists", () => {
    const dir = tempDir("tet-on-disk-");
    assert.equal(onDisk(dir), fs.realpathSync.native(dir));
  });

  it("keeps the part that does not exist yet as given, under its existing folder's real path", () => {
    const dir = tempDir("tet-on-disk-");
    assert.equal(onDisk(path.join(dir, "not", "yet")), path.join(fs.realpathSync.native(dir), "not", "yet"));
  });

  it("takes a relative path from the working folder", () => {
    assert.equal(onDisk("."), fs.realpathSync.native(process.cwd()));
  });
});

describe("two lists as sets", () => {
  it("are the same in any order", () => {
    assert.equal(sameSet(["a", "b"], ["b", "a"]), true);
  });

  it("differ by a member or by how many there are", () => {
    assert.equal(sameSet(["a", "b"], ["a", "c"]), false);
    assert.equal(sameSet(["a"], ["a", "a"]), false);
  });
});

describe("a module served to another process", () => {
  /** `module` served as its host would, each answer awaited by its request's id. */
  const serve = (module: object) => {
    const waiting = new Map<number, (response: UtilityResponse) => void>();
    const handle = serving(module, (response) => waiting.get(response.id)?.(response));
    return {
      handle,
      answer: (id: number) => new Promise<UtilityResponse>((resolve) => waiting.set(id, resolve)),
    };
  };

  it("answers a call with what its function returns, and a throw with its message", async () => {
    const { handle, answer } = serve({ add: (a: number, b: number) => a + b, fail: () => Promise.reject(new Error("no")) });
    const answers = [answer(1), answer(2), answer(3)];
    handle({ id: 1, method: "add", args: [1, 2] });
    handle({ id: 2, method: "fail", args: [] });
    handle({ id: 3, method: "missing", args: [] });
    assert.deepEqual(await answers[0], { id: 1, value: 3 });
    assert.deepEqual(await answers[1], { id: 2, error: "no" });
    assert.equal(typeof (await answers[2]).error, "string");
  });

  it("hands the function a signal where the caller's stood, fired by an abort, and still answers", async () => {
    const { handle, answer } = serve({
      wait: (label: string, signal: AbortSignal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(`${label} aborted`))),
    });
    const answered = answer(7);
    handle({ id: 7, method: "wait", args: ["search", undefined], signalAt: 1 });
    handle({ id: 7, abort: true });
    assert.deepEqual(await answered, { id: 7, value: "search aborted" });
  });
});
