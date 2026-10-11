import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { toContainerPath } from "../../src/main/agents/hook-target";
import { ensureRunning, mountAll, pathMountSpecs, revokeMounts, sessionMountSpecs } from "../../src/main/sbx/sbx-mounts";
import { PLATFORM } from "../../src/main/util/host-platform";
import { normalizeHostPath } from "../../src/main/util/path-inside";
import type { SbxProblems } from "../../src/shared/types/sbx";
import { tempDir } from "../helpers";

/** sbx/sbx-mounts.ts: bringing a sandbox's live mounts to what tet.json says, against a stand-in `sbx`. */

interface Answers {
  /** `inspect --json`'s live mounts as `HOST|TARGET[:ro]`; undefined: sbx cannot say. */
  live?: string[];
  /** The sandbox does not run until `exec` has been asked. */
  stopped?: boolean;
  /** The sandbox does not exist: `exec` fails. */
  missing?: boolean;
  /** `mount` / `umount` arguments sbx refuses. */
  refuseMount?: string[];
  refuseUnmount?: string[];
}

/** A stand-in `sbx` first on PATH answering mount commands from `answers`; every call is logged. */
async function withSbx<T>(answers: Answers, action: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
  const dir = tempDir("tet-sbx-mounts-");
  const log = path.join(dir, "calls.log");
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, JSON.stringify({ ...answers, started: !answers.stopped }));
  const script = path.join(dir, "sbx.js");
  fs.writeFileSync(
    script,
    `const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const fail = (message) => { process.stderr.write("ERROR: " + message + "\\n"); process.exit(1); };
if (args[0] === "inspect") {
  if (state.live === undefined) fail("sandbox not found");
  const mounts = state.live.map((spec) => {
    const readOnly = spec.endsWith(":ro");
    const [host, target] = (readOnly ? spec.slice(0, -3) : spec).split("|");
    return { host_path: host, container_target: target, ...(readOnly && { read_only: true }) };
  });
  process.stdout.write(JSON.stringify({ name: args[1], runtime_mounts: mounts }));
} else if (args[0] === "exec") {
  if (state.missing) fail("sandbox not found");
  state.started = true;
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
} else if (args[0] === "mount") {
  if (!state.started) fail("409 Conflict: sandbox is stopped");
  if ((state.refuseMount ?? []).includes(args[2])) fail("mount refused by policy");
} else if (args[0] === "umount") {
  if ((state.refuseUnmount ?? []).includes(args[2])) fail("busy");
}
`,
  );
  if (PLATFORM.executableByExtension) {
    fs.writeFileSync(path.join(dir, "sbx.cmd"), `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, "sbx"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  try {
    const result = await action();
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split(/\r?\n/) : [];
    return { result, calls };
  } finally {
    process.env.PATH = originalPath;
  }
}

/** A folder of this machine and its mount specs, as `sbx mount`/`umount` are handed them. */
function folder(prefix: string, access: "ro" | "rw" = "rw") {
  const host = normalizeHostPath(tempDir(prefix));
  return { host, ...pathMountSpecs({ path: host, access }) };
}

/** `inspect`'s live mount for a folder, spelled as the stand-in reads it (`HOST|TARGET[:ro]`). */
const liveOf = (mount: { host: string }, readOnly = false): string =>
  `${mount.host}|${toContainerPath(mount.host)}${readOnly ? ":ro" : ""}`;

describe("a sandbox's live mounts", () => {
  it("mounts only what the sandbox lacks, unmounts what it holds beyond the wanted, and leaves the rest", async () => {
    const [kept, added, stale] = [folder("tet-kept-"), folder("tet-added-"), folder("tet-stale-")];
    const { result, calls } = await withSbx({ live: [liveOf(kept), liveOf(stale)] }, () =>
      mountAll("tet-m-1", [kept, added], undefined, Promise.resolve(true)),
    );
    assert.deepEqual([...result], []);
    assert.deepEqual(calls, ["inspect tet-m-1 --json", `umount tet-m-1 ${stale.unmount}`, `mount tet-m-1 ${added.mount}`]);
  });

  it("takes another access for another grant: the held one goes first, then the new one comes", async () => {
    const readOnly = folder("tet-access-", "ro");
    const readWrite = { host: readOnly.host, ...pathMountSpecs({ path: readOnly.host, access: "rw" }) };
    const { calls } = await withSbx({ live: [liveOf(readOnly, true)] }, () =>
      mountAll("tet-m-2", [readWrite], undefined, Promise.resolve(true)),
    );
    assert.deepEqual(calls.slice(1), [`umount tet-m-2 ${readOnly.unmount}`, `mount tet-m-2 ${readWrite.mount}`]);
  });

  it("starts a stopped sandbox before mounting, unless a start underway has", async () => {
    const wanted = folder("tet-wanted-");
    const idle = await withSbx({ live: [], stopped: true }, () => mountAll("tet-m-3", [wanted]));
    assert.equal(idle.result.size, 0);
    assert.deepEqual(idle.calls, ["inspect tet-m-3 --json", "exec -i tet-m-3 true", `mount tet-m-3 ${wanted.mount}`]);

    const warm = await withSbx({ live: [] }, () => mountAll("tet-m-4", [wanted], undefined, Promise.resolve(true)));
    assert.ok(!warm.calls.some((call) => call.startsWith("exec")));
  });

  it("answers what sbx refused with its reason, and mounts the rest", async () => {
    const [refused, accepted] = [folder("tet-refused-"), folder("tet-accepted-")];
    const { result, calls } = await withSbx({ live: [], refuseMount: [refused.mount] }, () =>
      mountAll("tet-m-5", [refused, accepted], undefined, Promise.resolve(true)),
    );
    assert.deepEqual([...result.keys()], [refused.mount]);
    assert.match(result.get(refused.mount) ?? "", /mount refused by policy/);
    assert.ok(calls.includes(`mount tet-m-5 ${accepted.mount}`));
  });

  it("mounts everything where sbx cannot say what it holds", async () => {
    const wanted = folder("tet-unknown-");
    const { calls } = await withSbx({}, () => mountAll("tet-m-6", [wanted], undefined, Promise.resolve(true)));
    assert.deepEqual(calls, ["inspect tet-m-6 --json", `mount tet-m-6 ${wanted.mount}`]);
  });

  it("takes the sandbox's mounts one setup at a time", async () => {
    const [first, second] = [folder("tet-turn-a-"), folder("tet-turn-b-")];
    const { calls } = await withSbx({ live: [] }, async () => {
      await Promise.all([
        mountAll("tet-m-7", [first], undefined, Promise.resolve(true)),
        mountAll("tet-m-7", [second], undefined, Promise.resolve(true)),
      ]);
    });
    const inspections = calls.flatMap((call, index) => (call.startsWith("inspect") ? [index] : []));
    assert.equal(inspections.length, 2);
    assert.ok(inspections[1] > inspections[0] + 1, calls.join(" | "));
  });

  it("is running once `exec` answers, and not for a sandbox that does not exist", async () => {
    assert.equal((await withSbx({}, () => ensureRunning("tet-m-8"))).result, true);
    assert.equal((await withSbx({ missing: true }, () => ensureRunning("tet-m-8"))).result, false);
  });
});

describe("narrowing a sandbox's grants at Save", () => {
  const grant = (mount: ReturnType<typeof folder>, row: string) => ({
    mount: mount.mount,
    unmount: mount.unmount,
    option: "paths" as const,
    row,
  });

  it("takes out only the grants the sandbox holds, and says which sbx would not take back", async () => {
    const [held, gone, stuck] = [folder("tet-held-"), folder("tet-gone-"), folder("tet-stuck-")];
    const refused: SbxProblems = {};
    const { calls } = await withSbx({ live: [liveOf(held), liveOf(stuck)], refuseUnmount: [stuck.unmount] }, () =>
      revokeMounts("tet-r-1", [grant(held, "held"), grant(gone, "gone"), grant(stuck, "stuck")], refused),
    );
    assert.deepEqual(calls, ["inspect tet-r-1 --json", `umount tet-r-1 ${held.unmount}`, `umount tet-r-1 ${stuck.unmount}`]);
    assert.deepEqual(Object.keys(refused.paths ?? {}), ["stuck"]);
    assert.match(refused.paths?.stuck ?? "", /busy/);
  });

  it("takes out every grant where sbx cannot say what it holds", async () => {
    const [one, two] = [folder("tet-one-"), folder("tet-two-")];
    const { calls } = await withSbx({}, () => revokeMounts("tet-r-2", [grant(one, "one"), grant(two, "two")], {}));
    assert.deepEqual(calls, ["inspect tet-r-2 --json", `umount tet-r-2 ${one.unmount}`, `umount tet-r-2 ${two.unmount}`]);
  });
});

describe("a sandboxed agent's session mounts", () => {
  it("creates the host side first, a folder or a file, and never truncates the file", async () => {
    const within = tempDir("tet-session-mounts-");
    const folderHost = path.join(within, "sessions", "projects");
    const fileHost = path.join(within, "sessions", "index.jsonl");
    fs.mkdirSync(path.dirname(fileHost), { recursive: true });
    fs.writeFileSync(fileHost, "kept\n");
    const specs = await sessionMountSpecs([
      { host: folderHost, target: "/home/agent/.claude/projects", within },
      { host: fileHost, target: "/home/agent/.claude/index.jsonl", file: true, within },
    ]);
    assert.ok(fs.statSync(folderHost).isDirectory());
    assert.equal(fs.readFileSync(fileHost, "utf8"), "kept\n");
    assert.deepEqual(
      specs.map((spec) => spec.mount),
      [`${folderHost}:/home/agent/.claude/projects`, `${fileHost}:/home/agent/.claude/index.jsonl`],
    );
  });

  it("leaves out a host side that lies outside the sandbox's folder", async () => {
    const within = tempDir("tet-session-mounts-");
    const outside = path.join(tempDir("tet-session-outside-"), "projects");
    assert.deepEqual(await sessionMountSpecs([{ host: outside, target: "/home/agent/x", within }]), []);
  });
});
