import * as assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { ipcMain } from "electron";
import { registerAppIpc } from "../../src/main/ipc/app";
import { stopGitProcess } from "../../src/main/git/git-client";
import { PLATFORM } from "../../src/main/util/host-platform";
import { pathKey } from "../../src/main/util/process";
import type { Requirements } from "../../src/shared/types/agents";
import { forkUtilitiesInProcess, ROOT } from "../helpers";

/** ipc/: what the handlers do beyond passing on, and that every channel has one. */

describe("the startup gate", () => {
  const met: Requirements = {
    met: true,
    git: { name: "Git", command: "git", installed: true },
    agents: [],
    sbx: { name: "Docker Sandboxes", command: "sbx", installed: false },
    worktrees: true,
  };
  const unmet: Requirements = { ...met, met: false };

  function startup(initialRequirements: Promise<Requirements>) {
    let check!: () => Promise<Requirements>;
    let opened = 0;
    Object.assign(ipcMain, {
      handle: (channel: string, handler: () => Promise<Requirements>) => {
        if (channel === "startup:check") {
          check = handler;
        }
      },
      on: () => undefined,
    });
    registerAppIpc({
      initialRequirements,
      settings: {
        get: () => {
          throw new Error("startup does not read settings");
        },
        patch: () => false,
      },
      openWorkspace: async () => {
        opened += 1;
      },
      shutdown: () => undefined,
    });
    return { check: () => check(), opened: () => opened };
  }

  /** A fresh check finds the programs without starting the machine's agents or login shell. */
  function installedPrograms(t: TestContext) {
    forkUtilitiesInProcess();
    t.after(stopGitProcess);
    const paths = t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(null, `__TET_PATH_START__${process.env[pathKey(process.env)]}__TET_PATH_END__`, ""));
      return {};
    }) as typeof childProcess.execFile);
    const programs = t.mock.method(childProcess, "spawn", () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        child.stdout.write("git version 2.50.1\n");
        child.emit("close", 0);
      });
      return child as unknown as childProcess.ChildProcess;
    });
    return { paths, programs };
  }

  it("uses an already completed initial check without starting programs or reading PATH again", async (t) => {
    const { paths, programs } = installedPrograms(t);
    const initial = Promise.resolve(unmet);
    await initial;
    const gate = startup(initial);
    assert.strictEqual(await gate.check(), unmet);
    assert.equal(gate.opened(), 0);
    assert.equal(paths.mock.callCount(), 0);
    assert.equal(programs.mock.callCount(), 0);
  });

  it("opens no project until the initial check passes", async () => {
    let finish!: (result: Requirements) => void;
    const gate = startup(new Promise((resolve) => (finish = resolve)));
    const answer = gate.check();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(gate.opened(), 0);
    finish(met);
    assert.strictEqual(await answer, met);
    assert.equal(gate.opened(), 1);
  });

  it("re-checks programs and PATH after missing requirements", async (t) => {
    const { paths, programs } = installedPrograms(t);
    const gate = startup(Promise.resolve(unmet));
    assert.strictEqual(await gate.check(), unmet);
    assert.equal((await gate.check()).met, true);
    assert.equal(gate.opened(), 1);
    assert.ok(programs.mock.callCount() > 0);
    if (!PLATFORM.agentDirsKnown) {
      assert.equal(paths.mock.callCount(), 1);
    }
  });

  it("returns an initial failure to the window and allows a fresh retry", async (t) => {
    installedPrograms(t);
    const failure = new Error("initial check failed");
    const gate = startup(Promise.reject(failure));
    await assert.rejects(gate.check(), (error) => error === failure);
    assert.equal(gate.opened(), 0);
    assert.equal((await gate.check()).met, true);
    assert.equal(gate.opened(), 1);
  });
});

/**
 * The compiler holds a handler to its channel's types, but cannot tell one is missing: that channel
 * only fails once the window calls it.
 */
describe("the channels of shared/ipc.ts", () => {
  const mainSources = fs
    .readdirSync(path.join(ROOT, "src", "main"), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
  const channels = fs.readFileSync(path.join(ROOT, "src", "shared", "ipc.ts"), "utf8");

  const declaredIn = (name: string): string[] => {
    const body = new RegExp(`export interface ${name} \\{(.*?)\\n\\}`, "s").exec(channels)?.[1] ?? "";
    return [...body.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]);
  };
  const registeredBy = (...wrappers: string[]): Set<string> =>
    new Set([...mainSources.matchAll(new RegExp(`\\b(?:${wrappers.join("|")})\\(\\s*"([^"]+)"`, "g"))].map((match) => match[1]));
  const unhandled = (declared: string[], registered: Set<string>): string[] => declared.filter((channel) => !registered.has(channel));

  it("each have a handler where the window asks", () => {
    const declared = declaredIn("InvokeChannels");
    assert.ok(declared.length > 0, "InvokeChannels was read");
    assert.deepEqual(unhandled(declared, registeredBy("handle")), []);
  });

  it("each have a listener where the window sends", () => {
    const declared = declaredIn("SendChannels");
    assert.ok(declared.length > 0, "SendChannels was read");
    assert.deepEqual(unhandled(declared, registeredBy("on", "once")), []);
  });
});
