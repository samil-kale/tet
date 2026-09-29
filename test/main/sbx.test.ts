import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { LINUX, WINDOWS } from "../../src/shared/platform";
import { PLATFORM } from "../../src/main/util/host-platform";
import { claudeAgent } from "../../src/main/agents/claude";
import { toContainerPath } from "../../src/main/agents/hook-target";
import { readSbxConfig, writeSbxConfig } from "../../src/main/store/tet-json";
import { parsePublishedPorts, readSbxProblems, sandboxEnv, sandboxName, secretPlaceholder } from "../../src/main/sbx/sbx";
import { parseSignedInUser, sbxVersionSupported } from "../../src/main/sbx/sbx-cli";
import { droppedMountSpecs, fixedMountSpecs, mountDropped, pathMountSpecs, releaseDropped } from "../../src/main/sbx/sbx-mounts";
import { saveSbxConfig } from "../../src/main/sbx/sbx-save";
import { listSandboxes, readHostAllowed } from "../../src/main/sbx/sbx-status";
import { contractHome } from "../../src/main/util/path-inside";
import { isMountAllowed, parseFilesystemRules, parseGovernance } from "../../src/main/sbx/sbx-policy";
import { SbxAccountStore } from "../../src/main/sbx/sbx-accounts";
import { SbxLocalStore } from "../../src/main/sbx/sbx-local";
import { sandboxDir } from "../../src/main/store/project-dirs";
import { sbxProblemNotices, withoutProblems } from "../../src/shared/sbx-rules";
import { EMPTY_SBX_CONFIG, EMPTY_SBX_KNOWLEDGE, type SbxPath, type SbxPort, type SbxProjectConfig } from "../../src/shared/types/sbx";
import { fakeSafeStorage, tempDir } from "../helpers";

/** sbx/: sandbox names and mounts, ports, secrets, the SBX Settings' Save, policy and status. */

describe("sbx sandbox naming and mounts", () => {
  it("names a sandbox deterministically, within sbx create --name's own character set", () => {
    const project = { projectId: "a project id with spaces/slashes" };
    const name = sandboxName(project, "claude");
    assert.match(name, /^[a-z0-9][a-z0-9.-]+$/);
    assert.equal(name, sandboxName(project, "claude"), "stable across calls");
    assert.notEqual(name, sandboxName(project, "codex"), "one sandbox per agent too");
    assert.notEqual(name, sandboxName({ ...project, worktree: "k1" }, "claude"), "one per worktree: its workspace is its own");
  });

  it("mounts a Windows path the way sbx does inside the sandbox", {
    skip: !PLATFORM.driveLetters && "win32 only"
  }, () => {
    assert.equal(toContainerPath("C:\\Users\\saka\\Documents\\Workspace\\Private\\tet"), "/c/Users/saka/Documents/Workspace/Private/tet");
  });

  it("spells a Windows path the way it is on disk, since sbx mounts it that way", {
    skip: !PLATFORM.driveLetters && "win32 only"
  }, () => {
    const root = tempDir("tet-case-");
    fs.mkdirSync(path.join(root, "tet"));
    const onDisk = toContainerPath(path.join(root, "tet", "not-yet-written.json"));
    assert.equal(toContainerPath(path.join(root, "TET", "not-yet-written.json")), onDisk);
    assert.match(onDisk, /\/tet\/not-yet-written\.json$/);
  });

  it("leaves a macOS/Linux path untouched — already the same path inside and out", {
    skip: PLATFORM.driveLetters && "not win32"
  }, () => {
    assert.equal(toContainerPath("/Users/saka/project"), "/Users/saka/project");
  });

  it("mounts at the container path, :ro for read-only, and unmounts without the access", () => {
    const repo = path.join(os.tmpdir(), "repo");
    const target = toContainerPath(repo);
    assert.deepEqual(pathMountSpecs({ path: repo, access: "rw" }), { mount: `${repo}:${target}`, unmount: `${repo}:${target}` });
    assert.deepEqual(pathMountSpecs({ path: repo, access: "ro" }), { mount: `${repo}:${target}:ro`, unmount: `${repo}:${target}` });
  });

  it("spells a single file exactly like a folder — sbx mounts either in both forms", () => {
    const file = path.join(os.tmpdir(), "repo", ".npmrc");
    const target = toContainerPath(file);
    assert.deepEqual(pathMountSpecs({ path: file, access: "rw" }), { mount: `${file}:${target}`, unmount: `${file}:${target}` });
    assert.deepEqual(pathMountSpecs({ path: file, access: "ro" }), { mount: `${file}:${target}:ro`, unmount: `${file}:${target}` });
  });

  it("stores a folder under the home as ~/…, and anything else as typed", () => {
    const home = os.homedir();
    assert.equal(contractHome(path.join(home, "data", "sub") + path.sep), "~/data/sub");
    assert.equal(contractHome(` ${home} `), "~");
    assert.equal(contractHome("~/already"), "~/already");
    // Not the temp dir: on win32 that sits under the home too.
    const elsewhere = path.join(path.parse(home).root, "elsewhere");
    assert.equal(contractHome(elsewhere), elsewhere);
    assert.equal(contractHome("relative/path"), "relative/path");
  });

  it("normalizes a typed host path (trimmed, ~ expanded) before building its mount spec", () => {
    const data = path.join(os.tmpdir(), "data");
    assert.equal(pathMountSpecs({ path: ` ${os.tmpdir()}${path.sep}data${path.sep} `, access: "rw" }).unmount, `${data}:${toContainerPath(data)}`);
    const home = path.join(os.homedir(), "data");
    assert.equal(pathMountSpecs({ path: "~/data/", access: "rw" }).unmount, `${home}:${toContainerPath(home)}`);
  });

  it("mounts tet's own dir live — the sandbox's agentDir read-write, nothing else", () => {
    const agentDir = sandboxDir(os.tmpdir(), { projectId: "p" }, "claude");
    assert.deepEqual(
      fixedMountSpecs({ agentDir }).map((spec) => spec.mount),
      [`${agentDir}:${toContainerPath(agentDir)}`]
    );
  });
});

describe("a sandbox's published ports", () => {
  // `sbx ports <name> --json` after publishing 38111:8080 and 38112:9090.
  const published = JSON.stringify([
    { host_ip: "127.0.0.1", host_port: 38111, sandbox_port: 8080, protocol: "tcp4" },
    { host_ip: "127.0.0.1", host_port: 38112, sandbox_port: 9090, protocol: "tcp4" }
  ]);

  it("reads the ports as the dialog spells them", () => {
    assert.deepEqual(parsePublishedPorts(published), [
      { host: "38111", container: "8080" },
      { host: "38112", container: "9090" }
    ]);
  });

  it("reads none where the sandbox has none, or says something else entirely", () => {
    // An empty list is `[]`; a stopped sandbox answers "No published ports" as text.
    assert.deepEqual(parsePublishedPorts("[]"), []);
    assert.deepEqual(parsePublishedPorts("No published ports\n"), []);
    assert.deepEqual(parsePublishedPorts(""), []);
    assert.deepEqual(parsePublishedPorts(JSON.stringify([{ host_ip: "127.0.0.1", protocol: "tcp4" }])), []);
  });
});

/**
 * The dialog's Save against a stand-in `sbx`, the one seam where the whole run is visible: what it
 * publishes is the delta against what the sandbox *has* (`sbx ports --json`), never against
 * tet.json's previous rows — those may list a port sbx refused at the last Save.
 */
describe("saving an sbx config", () => {
  const projectId = "a project with one sandbox";
  const main = { projectId };
  const name = sandboxName(main, "claude");
  /** No knowledge before or after: nothing of it to revoke. */
  const NO_KNOWLEDGE = { previous: EMPTY_SBX_KNOWLEDGE, current: EMPTY_SBX_KNOWLEDGE };
  // `sbx ports --publish` of a port another sandbox holds.
  const refusal = "ERROR: publish ports: 409 Conflict: request[0]: port 127.0.0.1:3000/tcp4 is already published\n";

  const port = (number: number): SbxPort => ({ host: String(number), container: String(number) });
  /** One entry of `sbx ports --json` (see "a sandbox's published ports"). */
  const listed = (number: number) => ({ host_ip: "127.0.0.1", host_port: number, sandbox_port: number, protocol: "tcp4" });
  const config = (ports: SbxPort[]): SbxProjectConfig => ({ ...EMPTY_SBX_CONFIG, enabled: true, ports });

  /**
   * A stand-in `sbx` first on PATH (a `.cmd` on win32, an `sh` script elsewhere): it appends every
   * invocation to a log, one line each, and answers the subcommands Save runs. It lists one
   * sandbox, this project's Claude one, so the other two agents are skipped; `policy ls` answers
   * no rules, so hosts add nothing to the log.
   */
  function fakeSbx(answers: {
    published: object[];
    refuse?: string;
    secrets?: object[];
    secretsFail?: boolean;
    allowedHosts?: string[];
    /** More sandboxes `ls` lists, each with the project's folder unless it names another. */
    others?: { name: string; workspaces?: string[] }[];
    /** `inspect --json`'s `runtime_mounts`. */
    mounts?: object[];
    /** `policy ls --type filesystem`'s rules; none by default, which lets nothing be mounted. */
    filesystemRules?: object[];
    /** Calls that fail with nothing on stdout, by how their arguments start: sbx that cannot say. */
    fail?: string[];
  }): { dir: string; projectPath: string } {
    const dir = tempDir("tet-sbx-save-");
    const projectPath = path.join(dir, "repo");
    fs.mkdirSync(projectPath);
    const answerFile = path.join(dir, "answers.json");
    fs.writeFileSync(
      answerFile,
      JSON.stringify({ ...answers, refusal, name, workspaces: [projectPath], log: path.join(dir, "calls.log") })
    );
    const script = path.join(dir, "sbx.js");
    fs.writeFileSync(
      script,
      `const fs = require("node:fs");
const answers = JSON.parse(fs.readFileSync(${JSON.stringify(answerFile)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(answers.log, args.join(" ") + "\\n");
if ((answers.fail ?? []).some((prefix) => args.join(" ").startsWith(prefix))) {
  process.stderr.write("ERROR: ensure daemon\\n");
  process.exit(1);
} else if (args[0] === "ls") {
  const others = (answers.others ?? []).map((other) => ({ workspaces: answers.workspaces, ...other }));
  process.stdout.write(JSON.stringify({ sandboxes: [{ name: answers.name, workspaces: answers.workspaces }, ...others] }));
} else if (args[0] === "policy" && args[1] === "check") {
  // \`policy check network --json <host>\`: exit 1 with "allowed": false on a denial (sbx-status.ts).
  const allowed = (answers.allowedHosts ?? []).includes(args[4]);
  process.stdout.write(JSON.stringify({ allowed }));
  process.exit(allowed ? 0 : 1);
} else if (args[0] === "policy") {
  process.stdout.write(JSON.stringify({ rules: args.includes("filesystem") ? (answers.filesystemRules ?? []) : [] }));
} else if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify({ name: args[1], runtime_mounts: answers.mounts ?? [] }));
} else if (args[0] === "ports" && args[2] === "--json") {
  process.stdout.write(JSON.stringify(answers.published));
} else if (args[0] === "secret" && args[1] === "ls") {
  if (answers.secretsFail) {
    process.stderr.write("ERROR: secrets engine unavailable\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ secrets: [], custom_secrets: answers.secrets ?? [] }));
} else if (args[0] === "secret" && args[1] === "set-custom") {
  fs.appendFileSync(answers.log, "stdin " + fs.readFileSync(0, "utf8") + "\\n");
} else if (args[2] === "--publish" && args[3] === answers.refuse) {
  process.stderr.write(answers.refusal);
  process.exit(1);
} else if (args[0] === "ports" && (args[2] === "--publish" || args[2] === "--unpublish")) {
  // Kept, so what a later \`ports --json\` lists is what was published and not taken back.
  const [host, sandbox] = args[3].split(":").map(Number);
  const others = answers.published.filter((entry) => entry.host_port !== host || entry.sandbox_port !== sandbox);
  answers.published = args[2] === "--publish" ? [...others, { host_port: host, sandbox_port: sandbox }] : others;
  fs.writeFileSync(${JSON.stringify(answerFile)}, JSON.stringify(answers));
}
`
    );
    if (PLATFORM.executableByExtension) {
      fs.writeFileSync(path.join(dir, "sbx.cmd"), `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(dir, "sbx"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    }
    return { dir, projectPath };
  }

  /**
   * Runs `action` with the stand-in first on PATH, which is enough on win32 too (resolveCommand's
   * "takes a name's first folder on PATH"); answers its result and every `sbx` call it made.
   */
  async function withSbx<T>(dir: string, action: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      const result = await action();
      return { result, calls: fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split(/\r?\n/) };
    } finally {
      process.env.PATH = originalPath;
    }
  }

  /** saveSbxConfig as sbx-settings.ts runs it: with the listing taken for its check. */
  async function saveListed(...args: Parameters<typeof saveSbxConfig> extends [...infer A, unknown] ? A : never) {
    const sandboxes = await listSandboxes();
    assert.ok(sandboxes, "sbx lists the sandboxes");
    return saveSbxConfig(...args, sandboxes);
  }

  /** Saves `now` over a tet.json holding `before`, against a sandbox that has `has` published. */
  async function save(setup: { has: number[]; before: number[]; now: number[]; refuse?: string }) {
    const { dir, projectPath } = fakeSbx({ published: setup.has.map(listed), refuse: setup.refuse });
    await writeSbxConfig(projectPath, config(setup.before.map(port)));
    const saved = await withSbx(dir, () =>
      saveListed({ ref: main, path: projectPath }, [], config(setup.now.map(port)), NO_KNOWLEDGE, new Map(), new Set(), undefined)
    );
    return { ...saved, projectPath };
  }

  it("publishes a port tet.json already listed, because the sandbox never published it", async () => {
    const { result, calls } = await save({ has: [], before: [3000], now: [3000] });
    // Started and listed before anything changes (assertReadable), then worked against.
    assert.deepEqual(calls, [
      "ls --json",
      "policy ls --type network --include-inactive --json",
      `exec -i ${name} true`,
      `ports ${name} --json`,
      `ports ${name} --publish 3000:3000`
    ]);
    assert.deepEqual(result, { removed: [], orphans: [], refused: {}, failures: [], config: config([port(3000)]), knowledge: EMPTY_SBX_KNOWLEDGE });
  });

  it("brings a worktree's sandbox in line along with the project's, all but the ports", async () => {
    const worktree = { ref: { projectId, worktree: "k1" }, path: path.join(os.tmpdir(), "tet-sbx-save-worktree") };
    const worktreeName = sandboxName(worktree.ref, "claude");
    const { dir, projectPath } = fakeSbx({ published: [], others: [{ name: worktreeName, workspaces: [worktree.path] }] });
    const { result, calls } = await withSbx(dir, () =>
      saveListed(
        { ref: main, path: projectPath },
        [worktree],
        { ...config([port(3000)]), hosts: ["example.com"] },
        NO_KNOWLEDGE,
        new Map(),
        new Set(),
        undefined
      )
    );
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("ports ")),
      [`ports ${name} --json`, `ports ${name} --publish 3000:3000`],
      "the project's sandbox alone forwards the port"
    );
    for (const sandbox of [name, worktreeName]) {
      assert.ok(calls.includes(`policy allow network --sandbox ${sandbox} example.com`), `the hosts of ${sandbox}`);
    }
  });

  it("removes a worktree's sandbox along with the project's when sandboxing goes off", async () => {
    const worktree = { ref: { projectId, worktree: "k1" }, path: path.join(os.tmpdir(), "tet-sbx-save-worktree") };
    const worktreeName = sandboxName(worktree.ref, "claude");
    const { dir, projectPath } = fakeSbx({ published: [], others: [{ name: worktreeName, workspaces: [worktree.path] }] });
    const { result, calls } = await withSbx(dir, () =>
      saveListed({ ref: main, path: projectPath }, [worktree], EMPTY_SBX_CONFIG, NO_KNOWLEDGE, new Map(), new Set(), undefined)
    );
    assert.deepEqual(result.removed, [
      { ref: main, agentId: "claude" },
      { ref: worktree.ref, agentId: "claude" }
    ]);
    assert.ok(calls.includes(`rm ${worktreeName} --force`));
  });

  it("unpublishes what the sandbox has and tet.json dropped, and leaves a port in both alone", async () => {
    const { calls } = await save({ has: [4000, 5000], before: [4000, 5000], now: [5000, 3000] });
    assert.deepEqual(
      calls.filter((call) => call.includes("publish")),
      [`ports ${name} --unpublish 4000:4000`, `ports ${name} --publish 3000:3000`]
    );
  });

  it("leaves a port sbx refuses out of tet.json, with sbx's reason, and saves the rest", async () => {
    const { result, projectPath } = await save({ has: [], before: [], now: [3000, 5000], refuse: "3000:3000" });
    assert.deepEqual(result.refused, {
      ports: { "3000:3000": "publish ports: 409 Conflict: request[0]: port 127.0.0.1:3000/tcp4 is already published" }
    });
    assert.deepEqual(result.failures, [], "nothing to take back");
    assert.deepEqual((await readSbxConfig(projectPath)).ports, [port(5000)]);
  });

  it("does not start the sandbox where no port is configured and none was", async () => {
    const { calls } = await save({ has: [], before: [], now: [] });
    assert.deepEqual(calls, ["ls --json", "policy ls --type network --include-inactive --json"]);
  });

  it("unmounts a dropped path the sandbox holds, without starting it, and leaves one it does not hold alone", async () => {
    // Two folders that exist: only what exists is a grant.
    const held: SbxPath = { path: os.tmpdir(), access: "rw" };
    const unheld: SbxPath = { path: os.homedir(), access: "ro" };
    const { dir, projectPath } = fakeSbx({ published: [], mounts: [{ host_path: held.path, container_target: toContainerPath(held.path) }] });
    await writeSbxConfig(projectPath, { ...config([]), paths: [held, unheld] });
    const { result, calls } = await withSbx(dir, () =>
      saveListed({ ref: main, path: projectPath }, [], config([]), NO_KNOWLEDGE, new Map(), new Set(), undefined)
    );
    assert.deepEqual(calls.slice(2), [`inspect ${name} --json`, `umount ${name} ${pathMountSpecs(held).unmount}`]);
    assert.deepEqual([result.refused, result.config.paths], [{}, []]);
  });

  it("releases the dropped paths in or under a folder that goes, from every sandbox holding one", async () => {
    const going = tempDir("tet-going-");
    const inside = path.join(going, "sub");
    fs.mkdirSync(inside);
    const kept = tempDir("tet-kept-");
    const { dir } = fakeSbx({ published: [], filesystemRules: [{ resource_type: "filesystem", decision: "allow", resources: ["**"] }] });
    const rw = (host: string) => pathMountSpecs({ path: host, access: "rw" });
    const { calls } = await withSbx(dir, async () => {
      await mountDropped("tet-release-a", [], [inside, kept]);
      await mountDropped("tet-release-b", [], [going]);
      await releaseDropped(going);
    });
    assert.deepEqual(
      calls.filter((call) => call.startsWith("umount")),
      [`umount tet-release-a ${rw(inside).unmount}`, `umount tet-release-b ${rw(going).unmount}`]
    );
    assert.deepEqual(droppedMountSpecs("tet-release-a"), [rw(kept)], "the other path stays, for the next start's mountAll");
    assert.deepEqual(droppedMountSpecs("tet-release-b"), []);
  });

  it("brings the sandbox's secrets in line, values through stdin, leaving one set by hand alone", async () => {
    const live = (env: string, hosts: string[]) => ({ scope: name, targets: hosts, env: "", placeholder: secretPlaceholder(projectId, env) });
    const { dir, projectPath } = fakeSbx({
      published: [],
      secrets: [
        live("KEPT", ["kept.example.com"]),
        live("CHANGED", ["changed.example.com"]),
        live("REHOSTED", ["old.example.com"]),
        live("DROPPED", ["dropped.example.com"]),
        { scope: name, targets: ["hand.example.com"], env: "HAND", placeholder: "sbx-cs-byhand" }
      ]
    });
    const before = [
      { env: "KEPT", hosts: ["kept.example.com"] },
      { env: "CHANGED", hosts: ["changed.example.com"] },
      { env: "REHOSTED", hosts: ["old.example.com"] },
      { env: "DROPPED", hosts: ["dropped.example.com"] }
    ];
    await writeSbxConfig(projectPath, { ...EMPTY_SBX_CONFIG, enabled: true, secrets: before });
    const now = [
      { env: "KEPT", hosts: ["kept.example.com"] },
      { env: "CHANGED", hosts: ["changed.example.com"] },
      { env: "REHOSTED", hosts: ["new.example.com"] },
      { env: "ADDED", hosts: ["a.example.com", "*.b.example.com"] }
    ];
    const values = new Map([
      ["KEPT", "v-kept"],
      ["CHANGED", "v-changed"],
      ["REHOSTED", "v-rehosted"],
      ["ADDED", "v-added"]
    ]);
    const { result, calls } = await withSbx(dir, () =>
      saveListed({ ref: main, path: projectPath }, [], { ...EMPTY_SBX_CONFIG, enabled: true, secrets: now }, NO_KNOWLEDGE, values, new Set(["CHANGED"]), undefined)
    );
    const placeholder = (env: string) => secretPlaceholder(projectId, env);
    // The two listings run together, in either order.
    assert.deepEqual(calls.slice(1, 3).sort(), ["policy ls --type network --include-inactive --json", "secret ls --json"]);
    assert.deepEqual(calls.slice(3), [
      `secret rm --sandbox ${name} --placeholder ${placeholder("CHANGED")} -f`,
      `secret rm --sandbox ${name} --placeholder ${placeholder("REHOSTED")} -f`,
      `secret rm --sandbox ${name} --placeholder ${placeholder("DROPPED")} -f`,
      `secret set-custom --sandbox ${name} --placeholder ${placeholder("CHANGED")} --host changed.example.com`,
      "stdin v-changed",
      `secret set-custom --sandbox ${name} --placeholder ${placeholder("REHOSTED")} --host new.example.com`,
      "stdin v-rehosted",
      `secret set-custom --sandbox ${name} --placeholder ${placeholder("ADDED")} --host a.example.com --host *.b.example.com`,
      "stdin v-added"
    ]);
    assert.deepEqual([result.refused, result.failures], [{}, []]);
    assert.deepEqual((await readSbxConfig(projectPath)).secrets, now, "tet.json holds names and hosts");
    assert.ok(!fs.readFileSync(path.join(projectPath, "tet.json"), "utf8").includes("v-"), "no value reaches tet.json");
  });

  it("asks the policy about a secret host, but not about a wildcard it cannot answer", async () => {
    const { dir } = fakeSbx({ published: [], allowedHosts: ["open.example.com"] });
    const { result, calls } = await withSbx(dir, () =>
      Promise.all(["open.example.com", "closed.example.com", "*.example.com"].map(readHostAllowed))
    );
    assert.deepEqual(result, [true, false, true]);
    assert.deepEqual(calls.sort(), ["policy check network --json closed.example.com", "policy check network --json open.example.com"]);
  });

  it("removes a sandbox an earlier id of the project left, and no other", async () => {
    const { dir, projectPath } = fakeSbx({
      published: [],
      others: [
        { name: "tet-codex-aaaaaaaaaaaa" },
        { name: "tet-codex-bbbbbbbbbbbb", workspaces: ["/elsewhere"] },
        { name: "my-own-sandbox" }
      ]
    });
    const { result, calls } = await withSbx(dir, () =>
      saveListed({ ref: main, path: projectPath }, [], config([]), NO_KNOWLEDGE, new Map(), new Set(), undefined)
    );
    assert.deepEqual(result.orphans, [{ ref: main, agentId: "codex" }]);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("rm ")),
      ["rm tet-codex-aaaaaaaaaaaa --force"]
    );
  });

  it("stops a Save where sbx does not list the secrets, changing nothing", async () => {
    const { dir, projectPath } = fakeSbx({ published: [], secretsFail: true });
    const secrets = [{ env: "TOKEN", hosts: ["api.example.com"] }];
    const before = await readSbxConfig(projectPath);
    await assert.rejects(
      withSbx(dir, () =>
        saveListed({ ref: main, path: projectPath }, [], { ...EMPTY_SBX_CONFIG, enabled: true, secrets }, NO_KNOWLEDGE, new Map([["TOKEN", "v"]]), new Set(["TOKEN"]), undefined)
      ),
      /could not list the sandboxes' secrets/
    );
    const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
    assert.ok(!/secret rm|secret set-custom|^rm /m.test(calls), calls);
    assert.deepEqual(await readSbxConfig(projectPath), before, "tet.json as it was");
  });

  for (const [what, fail, message] of [
    ["the sandboxes' allowed hosts", "policy ls --type network", /could not list the sandboxes' allowed hosts/]
  ] as const) {
    it(`stops a Save where sbx does not list ${what}, changing nothing`, async () => {
      const { dir, projectPath } = fakeSbx({ published: [], fail: [fail] });
      await writeSbxConfig(projectPath, { ...EMPTY_SBX_CONFIG, enabled: true, hosts: ["old.example.com"] });
      const before = await readSbxConfig(projectPath);
      await assert.rejects(
        withSbx(dir, () =>
          saveListed({ ref: main, path: projectPath }, [], { ...EMPTY_SBX_CONFIG, enabled: true, hosts: ["new.example.com"] }, NO_KNOWLEDGE, new Map(), new Set(), undefined)
        ),
        message
      );
      const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
      assert.ok(!/policy rm|policy allow|^rm /m.test(calls), calls);
      assert.deepEqual(await readSbxConfig(projectPath), before, "tet.json as it was");
    });
  }

  for (const [what, fail, rows] of [
    ["the governed policy", "policy check", { hosts: ["closed.example.com"] }],
    ["the filesystem rules", "policy ls --type filesystem", { paths: [{ path: os.tmpdir(), access: "ro" }] }],
    ["the published ports", "ports", { ports: [port(3000)] }]
  ] satisfies [string, string, Partial<SbxProjectConfig>][]) {
    it(`rejects where sbx does not answer for ${what}, rather than finding a problem`, async () => {
      const { dir } = fakeSbx({ published: [], fail: [fail] });
      await assert.rejects(
        withSbx(dir, () =>
          readSbxProblems({
            projectId,
            config: { ...EMPTY_SBX_CONFIG, enabled: true, ...rows },
            knowledge: EMPTY_SBX_KNOWLEDGE,
            values: { secrets: new Set(), variables: new Set() },
            agents: [claudeAgent],
            organization: "acme",
            ports: true
          })
        ),
        /SBX could not/
      );
    });
  }

  it("finds what cannot be applied here: under governance a host its policy refuses, a missing or refused path, a secret or variable without a value", async () => {
    const { dir, projectPath } = fakeSbx({ published: [], allowedHosts: ["open.example.com"] });
    const missing = path.join(dir, "gone");
    const problems = await withSbx(dir, () =>
      readSbxProblems({
        projectId,
        config: {
          ...EMPTY_SBX_CONFIG,
          enabled: true,
          hosts: ["open.example.com", "closed.example.com"],
          // `policy ls` answers no filesystem rules, so nothing may be mounted.
          paths: [
            { path: missing, access: "ro" },
            { path: projectPath, access: "rw" }
          ],
          secrets: [{ env: "TOKEN", hosts: ["open.example.com"] }],
          variables: [{ env: "SET" }, { env: "UNSET" }]
        },
        knowledge: EMPTY_SBX_KNOWLEDGE,
        values: { secrets: new Set(), variables: new Set(["SET"]) },
        agents: [claudeAgent],
        organization: "acme",
        ports: false
      })
    );
    assert.deepEqual(problems.result, {
      hosts: { "closed.example.com": "Forbidden by governance" },
      paths: { [missing]: "Does not exist on this machine", [projectPath]: "Forbidden by governance" },
      secrets: { TOKEN: "No value on this machine" },
      variables: { UNSET: "No value on this machine" }
    });
  });

});

describe("what of the SBX Settings could not be applied", () => {
  const problems = {
    hosts: { "a.example.com": "Forbidden by governance", "b.example.com": "Forbidden by governance" },
    paths: { "/data/one": "Does not exist on this machine", "/data/two": "Forbidden by governance" },
    knowledge: { plugins: "Forbidden by governance" }
  };

  it("is told once per option and reason, its rows listed, in the dialog's tab order", () => {
    assert.deepEqual(sbxProblemNotices(problems), [
      "Couldn't set knowledge:\n - plugins\nForbidden by governance",
      "Couldn't set paths:\n - /data/one\nDoes not exist on this machine",
      "Couldn't set paths:\n - /data/two\nForbidden by governance",
      "Couldn't set hosts:\n - a.example.com\n - b.example.com\nForbidden by governance"
    ]);
  });

  it("is left out of what is saved and applied, a kind of knowledge turned off", () => {
    const config = {
      ...EMPTY_SBX_CONFIG,
      enabled: true,
      hosts: ["a.example.com", "c.example.com"],
      paths: [
        { path: "/data/one", access: "ro" as const },
        { path: "/data/three", access: "rw" as const }
      ]
    };
    const knowledge = { skills: "ro" as const, plugins: "rw" as const, instructions: false as const };
    assert.deepEqual(withoutProblems(config, knowledge, problems), {
      config: { ...config, hosts: ["c.example.com"], paths: [{ path: "/data/three", access: "rw" }] },
      knowledge: { skills: "ro", plugins: false, instructions: false }
    });
  });
});

describe("a sandboxed tab's variables", () => {
  it("put a secret's placeholder on the command line and a variable's value only in the environment", () => {
    const config = {
      ...EMPTY_SBX_CONFIG,
      enabled: true,
      secrets: [
        { env: "GITLAB_TOKEN", hosts: ["gitlab.example.com"] },
        { env: "NO_VALUE_HERE", hosts: ["api.example.com"] }
      ],
      // A hand-edited tet.json: one the agent sets, one a secret holds, one without a value here.
      variables: [{ env: "NPM_TOKEN" }, { env: "AGENT_SET" }, { env: "NO_VALUE_HERE" }, { env: "MISSING" }]
    };
    const result = sandboxEnv({
      ref: { projectId: "p" },
      config,
      env: ["AGENT_SET=agent"],
      secretValues: new Map([["GITLAB_TOKEN", "glpat-real"]]),
      variableValues: new Map([
        ["NPM_TOKEN", "npm-real"],
        ["AGENT_SET", "variable"],
        ["NO_VALUE_HERE", "real"]
      ])
    });
    assert.deepEqual(result.env, ["AGENT_SET=agent", `GITLAB_TOKEN=${secretPlaceholder("p", "GITLAB_TOKEN")}`]);
    assert.deepEqual(result.passed, { NPM_TOKEN: "npm-real" }, "a secret without a value never falls back to a real one");
    assert.doesNotMatch(result.env.join(" "), /real/, "no real value on the command line");
  });
});

describe("what sbx keeps on this machine", () => {
  it("counts a value as stored only where it can still be decrypted", () => {
    fakeSafeStorage();
    const store = new SbxLocalStore(tempDir("tet-secrets-"));
    const base64 = (text: string) => Buffer.from(text).toString("base64");
    store.restore("p", {
      secrets: { READABLE: base64("sealed:value"), LOST: base64("under another keychain") },
      variables: { NPM_TOKEN: base64("sealed:npm") }
    });
    assert.deepEqual(store.stored("p"), { secrets: ["READABLE"], variables: ["NPM_TOKEN"], knowledge: EMPTY_SBX_KNOWLEDGE });
    assert.deepEqual([...store.values("p", "secrets")], [["READABLE", "value"]]);
    assert.deepEqual([...store.values("p", "variables")], [["NPM_TOKEN", "npm"]]);
  });

  it("carries a stored value along a renamed row, and gives none to a row added under a stored name", () => {
    fakeSafeStorage();
    const store = new SbxLocalStore(tempDir("tet-secrets-"));
    const none = { values: {}, from: {} };
    store.update("p", { secrets: none, variables: { values: { OLD: "kept", GONE: "dropped" }, from: {} }, knowledge: EMPTY_SBX_KNOWLEDGE });
    // OLD renamed to NEW; GONE removed and a new row added under its name, left without a value.
    store.update("p", { secrets: none, variables: { values: {}, from: { NEW: "OLD" } }, knowledge: EMPTY_SBX_KNOWLEDGE });
    assert.deepEqual([...store.values("p", "variables")], [["NEW", "kept"]]);
  });

  it("keeps the knowledge on this machine, and no entry once it is all off", () => {
    fakeSafeStorage(false);
    const root = tempDir("tet-secrets-");
    const store = new SbxLocalStore(root);
    const none = { values: {}, from: {} };
    const knowledge = { skills: "ro" as const, plugins: false as const, instructions: "rw" as const, skillsFolder: "/skills" };
    store.update("p", { secrets: none, variables: none, knowledge });
    assert.deepEqual(new SbxLocalStore(root).knowledge("p"), knowledge, "read back, with no keyring needed");
    store.update("p", { secrets: none, variables: none, knowledge: EMPTY_SBX_KNOWLEDGE });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "sbx-local.json"), "utf8")), {}, "all off leaves no entry");
  });
});

describe("the Docker access tokens of the SBX Settings", () => {
  it("keep one row per user and carry a stored token along Save", () => {
    fakeSafeStorage();
    const root = tempDir("tet-sbx-accounts-");
    const store = new SbxAccountStore(root);
    const first = store.add("skale", "old");
    assert.equal(store.add("skale", "new").id, first.id, "the same user's token is replaced, not added");
    assert.equal(store.token(first.id), "new");
    // Kept as opened, a new one typed, one without a token dropped, the later of two users winning.
    store.update([
      { id: first.id, user: "skale", token: "" },
      { user: "other", token: "typed" },
      { user: "empty", token: "" },
      { user: "other", token: "later" }
    ]);
    const reread = new SbxAccountStore(root);
    assert.deepEqual(reread.list().map((account) => account.user), ["skale", "other"]);
    assert.equal(reread.token(first.id), "new");
    assert.equal(reread.token(reread.list()[1].id), "later");
    // Signed in from the row "other" under the name sbx gives: that row is renamed, never doubled.
    const other = reread.list()[1];
    assert.equal(reread.add("Other", "renamed", other.id).id, other.id);
    assert.deepEqual(reread.list().map((account) => account.user), ["skale", "Other"]);
    // A row of another spelling beside a kept one of sbx's name: merged into the kept one.
    const typed = reread.add("SKALE", "typed");
    assert.equal(reread.add("skale", "merged", typed.id).id, first.id);
    assert.deepEqual(reread.list().map((account) => account.user), ["skale", "Other"]);
    assert.equal(reread.token(first.id), "merged");
  });
});

describe("who sbx says is signed in", () => {
  it("is read off `sbx login`'s line, and nothing else", () => {
    assert.equal(parseSignedInUser("You are signed in [username: yaskor]\n"), "yaskor");
    assert.equal(parseSignedInUser("Not authenticated to Docker\n"), undefined);
    assert.equal(parseSignedInUser(""), undefined);
  });
});

describe("sbx's filesystem policy", () => {
  // `sbx policy ls --type filesystem --json` on an organization-governed account, trimmed to the
  // fields read. `local` is an ungoverned account's active defaults.
  const governed = JSON.stringify({
    rules: [
      { resource_type: "filesystem:read", decision: "allow", resources: ["**"], status: "inactive" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["**"], status: "inactive" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["C:\\**"], status: "active" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["/**"], status: "active" }
    ],
    organization: "prehcmservice"
  });
  const local = JSON.stringify({
    rules: [
      { resource_type: "filesystem:read", decision: "allow", resources: ["**"], status: "active" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["**"], status: "active" }
    ]
  });
  const win32 = { platform: WINDOWS, home: "C:\\Users\\saka" };
  const posix = { platform: LINUX, home: "/home/saka" };
  const rules = (entries: object[]) => parseFilesystemRules(JSON.stringify({ rules: entries }));
  const allow = (type: string, resource: string) => ({ resource_type: type, decision: "allow", resources: [resource] });

  it("reads only active rules, and nothing out of what is not JSON", () => {
    assert.equal(parseFilesystemRules(governed).length, 2);
    assert.deepEqual(parseFilesystemRules("Not authenticated"), []);
  });

  it("lets an organization granting write alone mount read-write and read-only", () => {
    const measured = parseFilesystemRules(governed);
    assert.ok(isMountAllowed(measured, "C:\\Users\\saka\\.tet\\projects\\p\\repository\\sandbox\\claude", "rw", win32));
    assert.ok(isMountAllowed(measured, "C:\\Users\\saka\\.tet\\projects\\p\\worktrees\\k1\\files", "ro", win32));
    assert.ok(!isMountAllowed(measured, "D:\\work", "rw", win32), "another drive matches no rule: default deny");
    assert.ok(isMountAllowed(measured, "/home/saka/work", "rw", posix));
  });

  it("allows everything under the local defaults' bare **", () => {
    assert.ok(isMountAllowed(parseFilesystemRules(local), "D:\\anywhere\\at\\all", "rw", win32));
    assert.ok(isMountAllowed(parseFilesystemRules(local), "/anywhere", "ro", posix));
  });

  it("matches * within one segment, ** at any depth and the folder itself", () => {
    const one = rules([allow("filesystem:write", "C:\\data\\*")]);
    assert.ok(isMountAllowed(one, "C:\\data\\project", "rw", win32));
    assert.ok(!isMountAllowed(one, "C:\\data\\project\\src", "rw", win32));
    const deep = rules([allow("filesystem:write", "C:\\data\\**")]);
    assert.ok(isMountAllowed(deep, "C:\\data\\project\\src", "rw", win32));
    assert.ok(isMountAllowed(deep, "C:\\data", "rw", win32));
    assert.ok(!isMountAllowed(deep, "C:\\database", "rw", win32));
  });

  it("expands ~ and *: for any drive, and ignores case on win32 alone", () => {
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "~\\.tet\\projects\\**")]), "C:\\Users\\saka\\.tet\\projects\\p", "rw", win32));
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "~/**")]), "/home/saka/tet", "rw", posix));
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "*:\\data\\**")]), "E:\\data\\x", "rw", win32));
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "c:\\USERS\\**")]), "C:\\Users\\saka", "rw", win32));
    assert.ok(!isMountAllowed(rules([allow("filesystem:write", "/Home/**")]), "/home/saka", "rw", posix));
  });

  it("needs write for read-write, and lets a deny outrank every allow", () => {
    const readOnly = rules([allow("filesystem:read", "/data/**")]);
    assert.ok(isMountAllowed(readOnly, "/data/x", "ro", posix));
    assert.ok(!isMountAllowed(readOnly, "/data/x", "rw", posix));
    const denied = rules([allow("filesystem", "/**"), { resource_type: "filesystem:read", decision: "deny", resources: ["/data/secret/**"] }]);
    assert.ok(isMountAllowed(denied, "/data/open", "rw", posix));
    assert.ok(!isMountAllowed(denied, "/data/secret/x", "ro", posix));
    assert.ok(!isMountAllowed(denied, "/data/secret/x", "rw", posix), "a read deny stops a writable mount too");
  });
});

describe("sbx's governance line", () => {
  it("names the organization of a governed account, nothing for an ungoverned one", () => {
    // `sbx policy ls` on an organization-governed account.
    const governed = [
      "Governance: Managed by prehcmservice | Sync: OK, last synced 08:18:18 | Hidden: 34 inactive rules. Show with: sbx policy ls --include-inactive",
      "",
      "POLICY      SOURCE   APPLIES TO   SUMMARY",
      "ALLOW ALL   org      all          filesystem write: 2 allow"
    ].join("\r\n");
    assert.equal(parseGovernance(governed), "prehcmservice");
    assert.equal(parseGovernance("Governance: managed by unknown organization (lookup failed)"), "unknown organization (lookup failed)");
    assert.equal(parseGovernance("POLICY    SOURCE   APPLIES TO   SUMMARY\nbalanced  local    all          network: 40 allow"), undefined);
  });
});

describe("sbx's version", () => {
  it("is supported from 0.45 on, where mounts survive a stop", () => {
    for (const [printed, supported] of [
      ["0.42.1", false],
      ["0.45.0", true],
      ["0.46.0", true],
      ["1.0.0", true]
    ] as const) {
      assert.equal(sbxVersionSupported(printed), supported, printed);
    }
  });
});
