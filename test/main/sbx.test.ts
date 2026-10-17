import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { LINUX, WINDOWS } from "../../src/shared/platform";
import { PLATFORM } from "../../src/main/util/host-platform";
import { claudeAgent } from "../../src/main/agents/claude";
import { toContainerPath } from "../../src/main/agents/hook-target";
import { readSbxSettings, writeSbxSettings } from "../../src/main/store/tet-json";
import { parsePublishedPorts, prepareSbxRun, readSbxProblems, sandboxEnv, sandboxName } from "../../src/main/sbx/sbx";
import { parseSignedInUser, sbxError, sbxVersionSupported } from "../../src/main/sbx/sbx-cli";
import { droppedMountSpecs, fixedMountSpecs, mountDropped, pathMountSpecs, releaseDropped } from "../../src/main/sbx/sbx-mounts";
import { saveSbxSettings, type SbxSaveTarget } from "../../src/main/sbx/sbx-save";
import { saveProjectSbx } from "../../src/main/sbx/sbx-settings";
import { getAgent } from "../../src/main/agents";
import type { Project } from "../../src/shared/types/project";
import { listSandboxes, readHostAllowed } from "../../src/main/sbx/sbx-status";
import { contractHome } from "../../src/main/util/path-inside";
import { isMountAllowed, parseFilesystemRules, parseGovernance } from "../../src/main/sbx/sbx-policy";
import { SbxAccountStore } from "../../src/main/sbx/sbx-accounts";
import { signInMcp } from "../../src/main/sbx/sbx-mcp";
import { SbxLocalStore } from "../../src/main/sbx/sbx-local";
import { sandboxDir } from "../../src/main/store/project-dirs";
import {
  SBX_PROBLEM,
  sameMcpUrl,
  sbxMcpRefusal,
  sbxNeedsRestart,
  sbxProblemNotices,
  sbxVariableRefusal,
  setupLines,
  withoutProblems,
} from "../../src/shared/sbx-rules";
import {
  EMPTY_SBX_SETTINGS,
  EMPTY_SBX_SKILLS,
  type SbxPath,
  type SbxLocalSave,
  type SbxPort,
  type SbxProjectSettings,
} from "../../src/shared/types/sbx";
import { fakeCommand, fakeSafeStorage, tempDir, withCommandOn, withEnvAsync } from "../helpers";

/** sbx/: sandbox names and mounts, ports, the SBX Settings' Save, policy and status. */

describe("sbx sandbox naming and mounts", () => {
  it("names a sandbox deterministically, within sbx create --name's own character set", () => {
    const project = { projectId: "a project id with spaces/slashes" };
    const name = sandboxName(project, "claude");
    assert.match(name, /^[a-z0-9][a-z0-9.-]+$/);
    assert.equal(name, sandboxName(project, "claude"), "stable across calls");
    assert.notEqual(name, sandboxName(project, "codex"), "one sandbox per agent too");
    assert.notEqual(name, sandboxName({ ...project, worktree: "k1" }, "claude"), "one per worktree: its workspace is its own");
  });

  it(
    "mounts a Windows path the way sbx does inside the sandbox",
    {
      skip: !PLATFORM.driveLetters && "win32 only",
    },
    () => {
      assert.equal(toContainerPath("C:\\Users\\saka\\Documents\\Workspace\\Private\\tet"), "/c/Users/saka/Documents/Workspace/Private/tet");
    },
  );

  it(
    "spells a Windows path the way it is on disk, since sbx mounts it that way",
    {
      skip: !PLATFORM.driveLetters && "win32 only",
    },
    () => {
      const root = tempDir("tet-case-");
      fs.mkdirSync(path.join(root, "tet"));
      const onDisk = toContainerPath(path.join(root, "tet", "not-yet-written.json"));
      assert.equal(toContainerPath(path.join(root, "TET", "not-yet-written.json")), onDisk);
      assert.match(onDisk, /\/tet\/not-yet-written\.json$/);
    },
  );

  it(
    "leaves a macOS/Linux path untouched — already the same path inside and out",
    {
      skip: PLATFORM.driveLetters && "not win32",
    },
    () => {
      assert.equal(toContainerPath("/Users/saka/project"), "/Users/saka/project");
    },
  );

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
    assert.equal(
      pathMountSpecs({ path: ` ${os.tmpdir()}${path.sep}data${path.sep} `, access: "rw" }).unmount,
      `${data}:${toContainerPath(data)}`,
    );
    const home = path.join(os.homedir(), "data");
    assert.equal(pathMountSpecs({ path: "~/data/", access: "rw" }).unmount, `${home}:${toContainerPath(home)}`);
  });

  it("mounts TET's own dir live — the sandbox's agentDir read-write, nothing else", () => {
    const agentDir = sandboxDir(os.tmpdir(), { projectId: "p" }, "claude");
    assert.deepEqual(
      fixedMountSpecs({ agentDir }).map((spec) => spec.mount),
      [`${agentDir}:${toContainerPath(agentDir)}`],
    );
  });
});

describe("a sandbox's published ports", () => {
  // `sbx ports <name> --json` after publishing 38111:8080 and 38112:9090.
  const published = JSON.stringify([
    { host_ip: "127.0.0.1", host_port: 38111, sandbox_port: 8080, protocol: "tcp4" },
    { host_ip: "127.0.0.1", host_port: 38112, sandbox_port: 9090, protocol: "tcp4" },
  ]);

  it("reads the ports as the dialog spells them", () => {
    assert.deepEqual(parsePublishedPorts(published), [
      { host: "38111", container: "8080" },
      { host: "38112", container: "9090" },
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
describe("saving SBX settings", () => {
  const projectId = "a project with one sandbox";
  const main = { projectId };
  const name = sandboxName(main, "claude");
  /** A worktree of the project, with a sandbox of its own. */
  const worktree = { ref: { projectId, worktree: "k1" }, path: path.join(os.tmpdir(), "tet-sbx-save-worktree") };
  const worktreeName = sandboxName(worktree.ref, "claude");
  /** No skills before or after: nothing of it to revoke. */
  const NO_SKILLS = { previous: EMPTY_SBX_SKILLS, current: EMPTY_SBX_SKILLS };
  // `sbx ports --publish` of a port another sandbox holds.
  const refusal = "ERROR: publish ports: 409 Conflict: request[0]: port 127.0.0.1:3000/tcp4 is already published\n";

  const port = (number: number): SbxPort => ({ host: String(number), container: String(number) });
  /** One entry of `sbx ports --json` (see "a sandbox's published ports"). */
  const listed = (number: number) => ({ host_ip: "127.0.0.1", host_port: number, sandbox_port: number, protocol: "tcp4" });
  const settings = (ports: SbxPort[]): SbxProjectSettings => ({ ...EMPTY_SBX_SETTINGS, enabled: true, ports });

  /**
   * A stand-in `sbx` first on PATH (a `.cmd` on win32, an `sh` script elsewhere): it appends every
   * invocation to a log, one line each, and answers the subcommands Save runs. It lists one
   * sandbox, this project's Claude one, so the other two agents are skipped; `policy ls` answers
   * no rules, so hosts add nothing to the log.
   */
  function fakeSbx(answers: {
    published: object[];
    refuse?: string;
    allowedHosts?: string[];
    /** `mcp ls --json`'s servers; `mcp add` registers more. */
    registered?: { name: string }[];
    /** The name `mcp add` refuses, as a policy without a rule for it does. */
    refuseMcp?: string;
    /** What `mcp unload` answers for a server: "not loaded" (a 404) or "failed", else it works. */
    unload?: "not loaded" | "failed";
    /** `ls` lists the project's sandbox as stopped; it runs otherwise. */
    stopped?: boolean;
    /** More sandboxes `ls` lists, each running with the project's folder unless it says otherwise. */
    others?: { name: string; workspaces?: string[]; status?: string }[];
    /** `inspect --json`'s `runtime_mounts`. */
    mounts?: object[];
    /** `policy ls --type filesystem`'s rules; none by default, which lets nothing be mounted. */
    filesystemRules?: object[];
    /** Calls that fail with nothing on stdout, by how their arguments start: sbx that cannot say. */
    fail?: string[];
  }): { dir: string; repoFolder: string } {
    const dir = tempDir("tet-sbx-save-");
    const repoFolder = path.join(dir, "repo");
    fs.mkdirSync(repoFolder);
    const answerFile = path.join(dir, "answers.json");
    fs.writeFileSync(answerFile, JSON.stringify({ ...answers, refusal, name, workspaces: [repoFolder], log: path.join(dir, "calls.log") }));
    fakeCommand(
      dir,
      "sbx",
      `const fs = require("node:fs");
const answers = JSON.parse(fs.readFileSync(${JSON.stringify(answerFile)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(answers.log, args.join(" ") + "\\n");
if ((answers.fail ?? []).some((prefix) => args.join(" ").startsWith(prefix))) {
  process.stderr.write("ERROR: ensure daemon\\n");
  process.exit(1);
} else if (args[0] === "ls") {
  const others = (answers.others ?? []).map((other) => ({ workspaces: answers.workspaces, status: "running", ...other }));
  const own = { name: answers.name, workspaces: answers.workspaces, status: answers.stopped ? "stopped" : "running" };
  process.stdout.write(JSON.stringify([own, ...others]));
} else if (args[0] === "policy" && args[1] === "check") {
  // \`policy check network --json <host>\`: exit 1 with "allowed": false on a denial (sbx-status.ts).
  const allowed = (answers.allowedHosts ?? []).includes(args[4]);
  process.stdout.write(JSON.stringify({ allowed }));
  process.exit(allowed ? 0 : 1);
} else if (args[0] === "policy") {
  process.stdout.write(JSON.stringify({ rules: args.includes("filesystem") ? (answers.filesystemRules ?? []) : [] }));
} else if (args[0] === "mcp" && args[1] === "ls") {
  process.stdout.write(JSON.stringify(answers.registered ?? []));
} else if (args[0] === "mcp" && args[1] === "add" && args[2] === answers.refuseMcp) {
  process.stderr.write("error: registration denied for MCP server\\n");
  process.exit(1);
} else if (args[0] === "mcp" && args[1] === "unload" && answers.unload) {
  process.stderr.write(answers.unload === "not loaded" ? "error: MCP server is not loaded in sandbox\\n" : "error: gateway unavailable\\n");
  process.exit(1);
} else if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify({ name: args[1], runtime_mounts: answers.mounts ?? [] }));
} else if (args[0] === "ports" && args[2] === "--json") {
  process.stdout.write(JSON.stringify(answers.published));
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
`,
    );
    return { dir, repoFolder };
  }

  /**
   * Runs `action` with the stand-in first on PATH, which is enough on win32 too (resolveCommand's
   * "takes a name's first folder on PATH"); answers its result and every `sbx` call it made.
   */
  async function withSbx<T>(dir: string, action: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
    const result = await withCommandOn(dir, action);
    return { result, calls: fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split(/\r?\n/) };
  }

  /** The listings every Save and aligning start reads the sandboxes with, together (readSandboxReads). */
  const READ_ROUND = ["policy ls --type network --include-inactive --json", "mcp ls --json"];
  const readRound = (call: string): boolean => READ_ROUND.includes(call);

  /**
   * Saves `request` for the project at `repoFolder`, with no skills, under the stand-in in `dir`:
   * saveSbxSettings as sbx-settings.ts runs it, with the listing taken for its check.
   */
  function saveIn(dir: string, repoFolder: string, request: SbxProjectSettings, { worktrees = [] }: { worktrees?: SbxSaveTarget[] } = {}) {
    return withSbx(dir, async () => {
      const sandboxes = await listSandboxes();
      assert.ok(sandboxes, "sbx lists the sandboxes");
      return saveSbxSettings({ ref: main, path: repoFolder }, worktrees, request, NO_SKILLS, undefined, sandboxes);
    });
  }

  /** Saves `now` over a tet.json holding `before`, against a sandbox that has `has` published. */
  async function save(setup: { has: number[]; before: number[]; now: number[]; refuse?: string }) {
    const { dir, repoFolder } = fakeSbx({ published: setup.has.map(listed), refuse: setup.refuse });
    await writeSbxSettings(repoFolder, settings(setup.before.map(port)));
    const saved = await saveIn(dir, repoFolder, settings(setup.now.map(port)));
    return { ...saved, repoFolder };
  }

  it("publishes a port tet.json already listed, because the sandbox never published it", async () => {
    const { result, calls } = await save({ has: [], before: [3000], now: [3000] });
    // Listed again within the sandbox's turn, for which runs now, and read before anything changes
    // (assertReadable), then worked against.
    assert.deepEqual(
      calls.filter((call) => !readRound(call)),
      ["ls --json", "ls --json", `ports ${name} --json`, `ports ${name} --publish 3000:3000`],
    );
    assert.deepEqual(calls.filter(readRound).sort(), [...READ_ROUND].sort());
    assert.deepEqual(result, {
      removed: [],
      orphans: [],
      refused: {},
      failures: [],
      settings: settings([port(3000)]),
      skills: EMPTY_SBX_SKILLS,
    });
  });

  it("brings a worktree's sandbox in line along with the project's, all but the ports", async () => {
    const { dir, repoFolder } = fakeSbx({ published: [], others: [{ name: worktreeName, workspaces: [worktree.path] }] });
    const { result, calls } = await saveIn(
      dir,
      repoFolder,
      { ...settings([port(3000)]), hosts: ["example.com"] },
      { worktrees: [worktree] },
    );
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("ports ")),
      [`ports ${name} --json`, `ports ${name} --publish 3000:3000`],
      "the project's sandbox alone forwards the port",
    );
    for (const sandbox of [name, worktreeName]) {
      assert.ok(calls.includes(`policy allow network --sandbox ${sandbox} example.com`), `the hosts of ${sandbox}`);
    }
  });

  it("removes a worktree's sandbox along with the project's when SBX is disabled", async () => {
    const { dir, repoFolder } = fakeSbx({ published: [], others: [{ name: worktreeName, workspaces: [worktree.path] }] });
    const { result, calls } = await saveIn(dir, repoFolder, EMPTY_SBX_SETTINGS, { worktrees: [worktree] });
    assert.deepEqual(result.removed, [
      { ref: main, agentId: "claude" },
      { ref: worktree.ref, agentId: "claude" },
    ]);
    assert.ok(calls.includes(`rm ${worktreeName} --force`));
  });

  it("unpublishes what the sandbox has and tet.json dropped, and leaves a port in both alone", async () => {
    const { calls } = await save({ has: [4000, 5000], before: [4000, 5000], now: [5000, 3000] });
    assert.deepEqual(
      calls.filter((call) => call.includes("publish")),
      [`ports ${name} --unpublish 4000:4000`, `ports ${name} --publish 3000:3000`],
    );
  });

  it("leaves a port sbx refuses out of tet.json, with sbx's reason, and saves the rest", async () => {
    const { result, repoFolder } = await save({ has: [], before: [], now: [3000, 5000], refuse: "3000:3000" });
    assert.deepEqual(result.refused, {
      ports: { "3000:3000": "publish ports: 409 Conflict: request[0]: port 127.0.0.1:3000/tcp4 is already published" },
    });
    assert.deepEqual(result.failures, [], "nothing to take back");
    assert.deepEqual((await readSbxSettings(repoFolder)).ports, [port(5000)]);
  });

  it("asks nothing of the ports where none is configured and none was", async () => {
    const { calls } = await save({ has: [], before: [], now: [] });
    assert.deepEqual(
      calls.filter((call) => !readRound(call)),
      ["ls --json"],
    );
  });

  it("starts no stopped sandbox: its ports are unpublished unseen, its hosts set, its MCP servers left to its next tab", async () => {
    const notion = { name: "notion", url: "https://mcp.notion.com/mcp" };
    const { dir, repoFolder } = fakeSbx({ published: [], stopped: true });
    await writeSbxSettings(repoFolder, settings([port(4000)]));
    const { result, calls } = await saveIn(dir, repoFolder, { ...settings([port(3000)]), hosts: ["example.com"], mcp: [notion] });
    assert.deepEqual(
      calls.filter((call) => call.startsWith("ports ") || call.startsWith("exec ") || call.startsWith("mcp load")),
      [`ports ${name} --unpublish 3000:3000`, `ports ${name} --unpublish 4000:4000`],
    );
    assert.ok(calls.includes(`policy allow network --sandbox ${name} example.com`));
    assert.ok(calls.includes(`mcp add notion --url ${notion.url} --skip-auth`), "registered all the same");
    assert.deepEqual(result.refused, {}, "what waits for the next tab is not refused");
    const saved = await readSbxSettings(repoFolder);
    assert.deepEqual([saved.ports, saved.hosts, saved.mcp], [[port(3000)], ["example.com"], [notion]]);
  });

  it("unpublishes a port in a stopped sandbox before a running one takes it", async () => {
    const stopped = sandboxName(main, "codex");
    const { dir, repoFolder } = fakeSbx({ published: [], others: [{ name: stopped, status: "stopped" }] });
    const { calls } = await saveIn(dir, repoFolder, settings([port(3000)]));
    assert.deepEqual(
      calls.filter((call) => call.startsWith("ports ") || call.startsWith("exec ")),
      [`ports ${name} --json`, `ports ${stopped} --unpublish 3000:3000`, `ports ${name} --publish 3000:3000`],
    );
  });

  it("unmounts a dropped path the sandbox holds, without starting it, and leaves one it does not hold alone", async () => {
    // Two folders that exist: only what exists is a grant.
    const held: SbxPath = { path: os.tmpdir(), access: "rw" };
    const unheld: SbxPath = { path: os.homedir(), access: "ro" };
    const { dir, repoFolder } = fakeSbx({
      published: [],
      mounts: [{ host_path: held.path, container_target: toContainerPath(held.path) }],
    });
    await writeSbxSettings(repoFolder, { ...settings([]), paths: [held, unheld] });
    const { result, calls } = await saveIn(dir, repoFolder, settings([]));
    assert.deepEqual(calls.filter((call) => !readRound(call)).slice(1), [
      `inspect ${name} --json`,
      `umount ${name} ${pathMountSpecs(held).unmount}`,
    ]);
    assert.deepEqual([result.refused, result.settings.paths], [{}, []]);
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
      [`umount tet-release-a ${rw(inside).unmount}`, `umount tet-release-b ${rw(going).unmount}`],
    );
    assert.deepEqual(droppedMountSpecs("tet-release-a"), [rw(kept)], "the other path stays, for the next start's mountAll");
    assert.deepEqual(droppedMountSpecs("tet-release-b"), []);
  });

  it("asks the policy about a host, but not about a wildcard it cannot answer", async () => {
    const { dir } = fakeSbx({ published: [], allowedHosts: ["open.example.com"] });
    const { result, calls } = await withSbx(dir, () =>
      Promise.all(["open.example.com", "closed.example.com", "*.example.com"].map(readHostAllowed)),
    );
    assert.deepEqual(result, [true, false, true]);
    assert.deepEqual(calls.sort(), ["policy check network --json closed.example.com", "policy check network --json open.example.com"]);
  });

  describe("MCP servers", () => {
    const notion = { name: "notion", url: "https://mcp.notion.com/mcp" };
    const mcpCalls = (calls: string[]): string[] => calls.filter((call) => call.startsWith("mcp ") && !call.startsWith("mcp ls"));
    const withMcp = (mcp: SbxProjectSettings["mcp"]): SbxProjectSettings => ({ ...EMPTY_SBX_SETTINGS, enabled: true, mcp });

    it("registers a server sbx does not have and loads it into the project's sandbox", async () => {
      const { dir, repoFolder } = fakeSbx({ published: [] });
      const { result, calls } = await saveIn(dir, repoFolder, withMcp([notion]));
      assert.deepEqual(mcpCalls(calls), [`mcp add notion --url ${notion.url} --skip-auth`, `mcp load notion --sandbox ${name}`]);
      assert.deepEqual([result.refused, result.settings.mcp], [{}, [notion]]);
      assert.deepEqual((await readSbxSettings(repoFolder)).mcp, [notion], "tet.json holds the row");
    });

    it("registers nothing sbx already has, and loads it all the same", async () => {
      const { dir, repoFolder } = fakeSbx({ published: [], registered: [{ name: "notion" }] });
      const { calls } = await saveIn(dir, repoFolder, withMcp([{ name: "notion", url: "" }]));
      assert.deepEqual(mcpCalls(calls), [`mcp load notion --sandbox ${name}`]);
    });

    it("unloads a row removed, and counts a server that was not loaded as gone", async () => {
      for (const unload of [undefined, "not loaded"] as const) {
        const { dir, repoFolder } = fakeSbx({ published: [], registered: [{ name: "notion" }], unload });
        await writeSbxSettings(repoFolder, withMcp([notion]));
        const { result, calls } = await saveIn(dir, repoFolder, withMcp([]));
        assert.deepEqual(mcpCalls(calls), [`mcp unload notion --sandbox ${name}`], String(unload));
        assert.deepEqual([result.refused, result.settings.mcp], [{}, []], String(unload));
      }
    });

    it("keeps the row of a server sbx would not unload", async () => {
      const { dir, repoFolder } = fakeSbx({ published: [], registered: [{ name: "notion" }], unload: "failed" });
      await writeSbxSettings(repoFolder, withMcp([notion]));
      const { result } = await saveIn(dir, repoFolder, withMcp([]));
      assert.deepEqual(result.refused, { mcp: { notion: "error: gateway unavailable" } });
      assert.deepEqual(result.settings.mcp, [notion], "still loaded, so still a row");
    });

    it("leaves out a server sbx refuses to register, loading nothing for it", async () => {
      const { dir, repoFolder } = fakeSbx({ published: [], refuseMcp: "notion" });
      const { result, calls } = await saveIn(dir, repoFolder, withMcp([notion]));
      assert.ok(!mcpCalls(calls).some((call) => call.startsWith("mcp load")));
      assert.deepEqual(Object.keys(result.refused.mcp ?? {}), ["notion"]);
      assert.deepEqual(result.settings.mcp, []);
    });

    it("signs a server in through the browser, and says what sbx said when it would not", async () => {
      const ok = fakeSbx({ published: [] });
      const signedIn = await withSbx(ok.dir, () => signInMcp("notion"));
      assert.deepEqual([signedIn.result, signedIn.calls], [undefined, ["mcp auth notion"]]);
      const failing = fakeSbx({ published: [], fail: ["mcp auth"] });
      const refused = await withSbx(failing.dir, () => signInMcp("notion"));
      assert.match(refused.result ?? "", /ensure daemon/);
    });

    it("stops a Save where sbx does not list the registered servers, changing nothing", async () => {
      const { dir, repoFolder } = fakeSbx({ published: [], fail: ["mcp ls"] });
      await assert.rejects(saveIn(dir, repoFolder, withMcp([notion])), /could not list its registered MCP servers/);
    });
  });

  it("removes a sandbox an earlier id of the project left, and no other", async () => {
    const { dir, repoFolder } = fakeSbx({
      published: [],
      others: [
        { name: "tet-codex-aaaaaaaaaaaa" },
        { name: "tet-codex-bbbbbbbbbbbb", workspaces: ["/elsewhere"] },
        { name: "my-own-sandbox" },
      ],
    });
    const { result, calls } = await saveIn(dir, repoFolder, settings([]));
    assert.deepEqual(result.orphans, [{ ref: main, agentId: "codex" }]);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("rm ")),
      ["rm tet-codex-aaaaaaaaaaaa --force"],
    );
  });

  it("stops a Save where sbx does not list the sandboxes' allowed hosts, changing nothing", async () => {
    const { dir, repoFolder } = fakeSbx({ published: [], fail: ["policy ls --type network"] });
    await writeSbxSettings(repoFolder, { ...EMPTY_SBX_SETTINGS, enabled: true, hosts: ["old.example.com"] });
    const before = await readSbxSettings(repoFolder);
    await assert.rejects(
      saveIn(dir, repoFolder, { ...EMPTY_SBX_SETTINGS, enabled: true, hosts: ["new.example.com"] }),
      /could not list the sandboxes' allowed hosts/,
    );
    const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
    assert.ok(!/policy rm|policy allow|^rm /m.test(calls), calls);
    assert.deepEqual(await readSbxSettings(repoFolder), before, "tet.json as it was");
  });

  for (const [what, fail, rows] of [
    ["the governed policy", "policy check", { hosts: ["closed.example.com"] }],
    ["the filesystem rules", "policy ls --type filesystem", { paths: [{ path: os.tmpdir(), access: "ro" }] }],
    ["the published ports", "ports", { ports: [port(3000)] }],
  ] satisfies [string, string, Partial<SbxProjectSettings>][]) {
    it(`rejects where sbx does not answer for ${what}, rather than finding a problem`, async () => {
      const { dir } = fakeSbx({ published: [], fail: [fail] });
      await assert.rejects(
        withSbx(dir, () =>
          readSbxProblems({
            projectId,
            settings: { ...EMPTY_SBX_SETTINGS, enabled: true, ...rows },
            skills: EMPTY_SBX_SKILLS,
            values: { variables: new Set() },
            agents: [claudeAgent],
            organization: "acme",
            ports: true,
          }),
        ),
        /SBX could not/,
      );
    });
  }

  it("finds what cannot be applied here: under governance a host its policy refuses, a missing or refused path, a variable without a value", async () => {
    const { dir, repoFolder } = fakeSbx({ published: [], allowedHosts: ["open.example.com"] });
    const missing = path.join(dir, "gone");
    const problems = await withSbx(dir, () =>
      readSbxProblems({
        projectId,
        settings: {
          ...EMPTY_SBX_SETTINGS,
          enabled: true,
          hosts: ["open.example.com", "closed.example.com"],
          // `policy ls` answers no filesystem rules, so nothing may be mounted.
          paths: [
            { path: missing, access: "ro" },
            { path: repoFolder, access: "rw" },
          ],
          variables: [{ env: "SET" }, { env: "UNSET" }],
        },
        skills: EMPTY_SBX_SKILLS,
        values: { variables: new Set(["SET"]) },
        agents: [claudeAgent],
        organization: "acme",
        ports: false,
      }),
    );
    assert.deepEqual(problems.result, {
      hosts: { "closed.example.com": "Forbidden by governance" },
      paths: { [missing]: "Does not exist on this machine", [repoFolder]: "Forbidden by governance" },
      variables: { UNSET: "No value on this machine" },
    });
  });

  describe("at a tab's start", () => {
    const ALLOW_ALL = [{ resource_type: "filesystem", decision: "allow", resources: ["**"] }];
    const notion = { name: "notion", url: "https://mcp.notion.com/mcp" };
    /** What a start asks of sbx to bring its sandbox in line, apart from its mounts. */
    const aligning = (calls: string[]): string[] => calls.filter((call) => /^(policy (ls --type network|allow|rm)|mcp|ports) /.test(call));

    /** Starts a Claude tab of the project at `at`, sbx listing its sandbox at `repoFolder`. */
    const start = (dir: string, repoFolder: string, rows: Partial<SbxProjectSettings>, at = repoFolder, warm?: Promise<boolean>) =>
      // The first-run marker of sbx goes beside the stand-in, not into this machine's profile.
      withEnvAsync({ LOCALAPPDATA: dir, HOME: dir }, () =>
        prepareSbxRun({
          agent: claudeAgent,
          name,
          ref: main,
          projectRefPath: at,
          settings: { ...EMPTY_SBX_SETTINGS, enabled: true, ...rows },
          skills: EMPTY_SBX_SKILLS,
          sandboxes: new Map([[name, { workspaces: [repoFolder], running: true }]]),
          paths: { agentDir: sandboxDir(dir, main, "claude") },
          agentArgs: [],
          variableValues: new Map(),
          warm,
        }),
      );

    it("unpublishes a port tet.json no longer lists, in a sandbox already running", async () => {
      const stale = 47815;
      const { dir, repoFolder } = fakeSbx({ published: [listed(stale)], filesystemRules: ALLOW_ALL });
      await writeSbxSettings(repoFolder, { ...EMPTY_SBX_SETTINGS, enabled: true });
      const { calls } = await withSbx(dir, () => start(dir, repoFolder, {}, repoFolder, Promise.resolve(true)));
      assert.deepEqual(
        calls.filter((call) => call.includes("publish")),
        [`ports ${name} --unpublish ${stale}:${stale}`],
      );
    });

    for (const created of [true, false]) {
      it(`keeps ${created ? "the sandbox it created" : "a sandbox it found"} when it fails afterwards, for the next start to bring in line`, async () => {
        const { dir, repoFolder } = fakeSbx({ published: [], fail: ["policy ls --type filesystem"] });
        // Listed at another folder, the sandbox is rebuilt: removed, then created at this one.
        const at = created ? path.join(dir, "moved") : repoFolder;
        const { calls } = await withSbx(dir, () =>
          assert.rejects(start(dir, repoFolder, { paths: [{ path: os.tmpdir(), access: "ro" }] }, at), /SBX could not/),
        );
        assert.deepEqual(
          calls.filter((call) => /^(rm|create) /.test(call)),
          created ? [`rm ${name} --force`, `create claude ${at} --name ${name} --skills=off`] : [],
        );
      });
    }

    it("brings a sandbox it found in line with tet.json both ways, at every start", async () => {
      // Ports nothing here listens on: the start asks this machine whether a new one is free.
      const [wanted, stale] = [47813, 47814];
      const { dir, repoFolder } = fakeSbx({ published: [listed(stale)], filesystemRules: ALLOW_ALL, registered: [{ name: "stale" }] });
      const rows = { ports: [port(wanted)], hosts: ["example.com"], mcp: [notion] };
      const onDisk = (saved: Partial<SbxProjectSettings>) =>
        writeSbxSettings(repoFolder, { ...EMPTY_SBX_SETTINGS, enabled: true, ...saved });
      await onDisk(rows);
      const first = await withSbx(dir, () => start(dir, repoFolder, rows));
      assert.deepEqual(first.result.problems, {});
      assert.deepEqual(
        aligning(first.calls).filter((call) => !/ ls |--json$/.test(call)),
        [
          `mcp add notion --url ${notion.url} --skip-auth`,
          `policy allow network --sandbox ${name} example.com`,
          `mcp load notion --sandbox ${name}`,
          `mcp unload stale --sandbox ${name}`,
          `ports ${name} --unpublish ${stale}:${stale}`,
          `ports ${name} --publish ${wanted}:${wanted}`,
        ],
      );
      fs.rmSync(path.join(dir, "calls.log"));
      const second = await withSbx(dir, () => start(dir, repoFolder, rows));
      assert.deepEqual(
        [READ_ROUND.every((listing) => second.calls.includes(listing)), second.calls.filter((call) => call.includes("publish"))],
        [true, []],
        "a second tab of the sandbox lists it again, and finds the ports in place",
      );
      fs.rmSync(path.join(dir, "calls.log"));
      await onDisk({ ...rows, hosts: ["saved.example.com"] });
      const savedOver = await withSbx(dir, () => start(dir, repoFolder, rows));
      assert.deepEqual(
        aligning(savedOver.calls).filter((call) => !/ ls |--json$/.test(call) && !call.startsWith("mcp inspect")),
        [],
        "rows a Save replaced while the tab started are not applied",
      );
      assert.deepEqual([first.result.savedOver, savedOver.result.savedOver], [false, true], "and the tab is told so");
    });

    it("tells a row left out at every start", async () => {
      const { dir, repoFolder } = fakeSbx({ published: [], filesystemRules: ALLOW_ALL });
      const rows = { variables: [{ env: "TOKEN" }] };
      await writeSbxSettings(repoFolder, { ...EMPTY_SBX_SETTINGS, enabled: true, ...rows });
      const first = await withSbx(dir, () => start(dir, repoFolder, rows));
      assert.deepEqual(first.result.problems, { variables: { TOKEN: SBX_PROBLEM.noValue } });
      fs.rmSync(path.join(dir, "calls.log"));
      const second = await withSbx(dir, () => start(dir, repoFolder, rows));
      assert.deepEqual(second.result.problems, first.result.problems, "told at every start all the same");
    });

    it("lists the hosts and MCP servers once for its check and its alignment", async () => {
      const { dir, repoFolder } = fakeSbx({ published: [], filesystemRules: ALLOW_ALL });
      const rows = { hosts: ["example.com"], mcp: [notion] };
      await writeSbxSettings(repoFolder, { ...EMPTY_SBX_SETTINGS, enabled: true, ...rows });
      const { calls } = await withSbx(dir, () => start(dir, repoFolder, rows));
      const listings = ["policy ls --type network", "mcp ls"];
      assert.deepEqual(
        listings.map((listing) => calls.filter((call) => call.startsWith(`${listing} `)).length),
        listings.map(() => 1),
        calls.join("\n"),
      );
    });
  });

  describe("through the project's Save", () => {
    const noLocal = (variables: Record<string, string> = {}): SbxLocalSave => ({
      variables: { values: variables, from: {} },
      skills: EMPTY_SBX_SKILLS,
    });
    const projectOf = (repoFolder: string): Project => ({ id: projectId, path: repoFolder, name: "repo", worktrees: [] });
    const saveProject = (dir: string, repoFolder: string, request: SbxProjectSettings, local: SbxLocalSave, sbxLocal: SbxLocalStore) =>
      withSbx(dir, () => saveProjectSbx({ sbxLocal, notice: () => undefined }, projectOf(repoFolder), request, local));

    it("stops before changing anything when sbx cannot list the sandboxes, and keeps the values it had", async () => {
      fakeSafeStorage();
      const { dir, repoFolder } = fakeSbx({ published: [], fail: ["ls"] });
      const sbxLocal = new SbxLocalStore(tempDir("tet-sbx-local-"));
      sbxLocal.update(projectId, noLocal({ OLD: "kept" }));
      const { result } = await saveProject(dir, repoFolder, settings([]), noLocal({ NEW: "typed" }), sbxLocal).catch(() => ({
        result: undefined,
      }));
      assert.ok(result && !result.ok);
      assert.match(result.error ?? "", /could not list the sandboxes\. Nothing was saved/);
      assert.deepEqual(sbxLocal.stored(projectId).variables, ["OLD"], "the typed value is not kept for a Save that did not happen");
    });

    it("tells the user of a sandbox it removed when SBX is switched off", async () => {
      fakeSafeStorage();
      const { dir, repoFolder } = fakeSbx({ published: [] });
      const notices: string[] = [];
      const { result, calls } = await withSbx(dir, () =>
        saveProjectSbx(
          { sbxLocal: new SbxLocalStore(tempDir("tet-sbx-local-")), notice: (_severity, message) => notices.push(message) },
          projectOf(repoFolder),
          { ...EMPTY_SBX_SETTINGS, enabled: false },
          noLocal(),
        ),
      );
      assert.deepEqual(result, { ok: true, problems: {} });
      assert.ok(calls.includes(`rm ${name} --force`));
      assert.deepEqual(notices, [`The ${getAgent("claude").displayName} sandbox of repo was removed.`]);
    });
  });
});

describe("what of the SBX Settings could not be applied", () => {
  const problems = {
    hosts: { "a.example.com": "Forbidden by governance", "b.example.com": "Forbidden by governance" },
    paths: { "/data/one": "Does not exist on this machine", "/data/two": "Forbidden by governance" },
    skills: { instructions: "Forbidden by governance" },
  };

  it("is told once per option and reason, its rows listed, in the dialog's tab order", () => {
    assert.deepEqual(sbxProblemNotices(problems), [
      "Could not set skills:\n - instructions\nForbidden by governance",
      "Could not set paths:\n - /data/one\nDoes not exist on this machine",
      "Could not set paths:\n - /data/two\nForbidden by governance",
      "Could not set hosts:\n - a.example.com\n - b.example.com\nForbidden by governance",
    ]);
  });

  it("says the setup script was run, not set", () => {
    assert.deepEqual(sbxProblemNotices({ setup: { "sh: 1: abt-get: not found": SBX_PROBLEM.failed } }), [
      "Could not run setup:\n - sh: 1: abt-get: not found\nTried again at the next start",
    ]);
  });

  it("is left out of what is saved and applied, a kind of skills turned off", () => {
    const settings = {
      ...EMPTY_SBX_SETTINGS,
      enabled: true,
      hosts: ["a.example.com", "c.example.com"],
      paths: [
        { path: "/data/one", access: "ro" as const },
        { path: "/data/three", access: "rw" as const },
      ],
    };
    const skills = { skills: "ro" as const, instructions: "rw" as const };
    assert.deepEqual(withoutProblems(settings, skills, problems), {
      settings: { ...settings, hosts: ["c.example.com"], paths: [{ path: "/data/three", access: "rw" }] },
      skills: { skills: "ro", instructions: false },
    });
  });
});

describe("the SBX Settings' setup script", () => {
  const loaded = { ...EMPTY_SBX_SETTINGS, setup: ["apt-get update", "apt-get install -y ffmpeg"] };
  const restart = (setup: string[]): boolean => sbxNeedsRestart(loaded, EMPTY_SBX_SKILLS, { ...loaded, setup }, EMPTY_SBX_SKILLS);

  it("waits for a restart once changed, never once emptied", () => {
    assert.equal(restart(loaded.setup), false, "unchanged");
    assert.equal(restart([...loaded.setup, "npm i -g pnpm"]), true, "a line added");
    assert.equal(restart(["apt-get update", "apt-get install -y ffmpeg imagemagick"]), true, "a line changed");
    assert.equal(restart([]), false, "emptied");
  });

  it("is kept by its lines as typed, without trailing whitespace or blank lines at either end", () => {
    assert.deepEqual(setupLines("\r\n\napt-get update  \r\nif true; then\n  echo hi\nfi\n\n"), [
      "apt-get update",
      "if true; then",
      "  echo hi",
      "fi",
    ]);
    assert.deepEqual(setupLines("a\n\nb"), ["a", "", "b"], "a blank line inside stays");
    assert.deepEqual(setupLines(" \n\t\n"), []);
  });
});

describe("an SBX Settings variable row", () => {
  it("is refused a name TET sets itself or another variable holds", () => {
    assert.equal(sbxVariableRefusal({ env: "TOKEN" }, [], false), undefined);
    for (const env of ["PATH", "path", "TET_TAB_ID"]) {
      assert.ok(sbxVariableRefusal({ env }, [], false), env);
    }
    assert.ok(sbxVariableRefusal({ env: "TOKEN" }, [{ env: "TOKEN" }], false));
  });
});

describe("an SBX Settings MCP row", () => {
  it("takes one server per name", () => {
    const notion = { name: "notion", url: "https://mcp.notion.com/mcp" };
    assert.equal(sbxMcpRefusal(notion, []), undefined);
    assert.ok(sbxMcpRefusal(notion, [{ name: " notion ", url: "" }]));
  });

  it("takes an http(s) URL, an image of sbx's own registry or none, and nothing else", () => {
    const refusal = (url: string) => sbxMcpRefusal({ name: "notion", url }, []);
    for (const url of ["", " https://mcp.notion.com/mcp ", "http://localhost:3000/mcp", "dhi.io/notion:1"]) {
      assert.equal(refusal(url), undefined, url);
    }
    for (const url of ["mcp.notion.com/mcp", "https://", "ftp://mcp.notion.com", "https://mcp notion.com", "dhi.io/a b"]) {
      assert.ok(refusal(url), url);
    }
  });

  it("reads a URL as the one it was registered under, apart from a trailing slash", () => {
    assert.ok(sameMcpUrl("https://mcp.notion.com/mcp", " https://mcp.notion.com/mcp/ "));
    assert.ok(!sameMcpUrl("https://mcp.notion.com/mcp", "https://mcp.linear.app/mcp"));
  });
});

describe("a sandboxed tab's variables", () => {
  it("put a variable's value only in the environment, never on the command line", () => {
    const settings = {
      ...EMPTY_SBX_SETTINGS,
      enabled: true,
      // A hand-edited tet.json: one the agent sets, one without a value here.
      variables: [{ env: "NPM_TOKEN" }, { env: "AGENT_SET" }, { env: "MISSING" }],
    };
    const result = sandboxEnv({
      settings,
      env: ["AGENT_SET=agent"],
      variableValues: new Map([
        ["NPM_TOKEN", "npm-real"],
        ["AGENT_SET", "variable"],
      ]),
    });
    assert.deepEqual(result.env, ["AGENT_SET=agent"]);
    assert.deepEqual(result.passed, { NPM_TOKEN: "npm-real" }, "a variable without a value is left out");
    assert.doesNotMatch(result.env.join(" "), /real/, "no real value on the command line");
  });
});

describe("what sbx keeps on this machine", () => {
  it("counts a value as stored only where it can still be decrypted", () => {
    fakeSafeStorage();
    const store = new SbxLocalStore(tempDir("tet-sbx-local-"));
    const base64 = (text: string) => Buffer.from(text).toString("base64");
    store.restore("p", {
      variables: { NPM_TOKEN: base64("sealed:npm"), LOST: base64("under another keychain") },
    });
    assert.deepEqual(store.stored("p"), { variables: ["NPM_TOKEN"], skills: EMPTY_SBX_SKILLS });
    assert.deepEqual([...store.variableValues("p")], [["NPM_TOKEN", "npm"]]);
  });

  it("carries a stored value along a renamed row, and gives none to a row added under a stored name", () => {
    fakeSafeStorage();
    const store = new SbxLocalStore(tempDir("tet-sbx-local-"));
    store.update("p", { variables: { values: { OLD: "kept", GONE: "dropped" }, from: {} }, skills: EMPTY_SBX_SKILLS });
    // OLD renamed to NEW; GONE removed and a new row added under its name, left without a value.
    store.update("p", { variables: { values: {}, from: { NEW: "OLD" } }, skills: EMPTY_SBX_SKILLS });
    assert.deepEqual([...store.variableValues("p")], [["NEW", "kept"]]);
  });

  it("keeps the skills on this machine, and no entry once it is all off", () => {
    fakeSafeStorage(false);
    const root = tempDir("tet-sbx-local-");
    const store = new SbxLocalStore(root);
    const none = { values: {}, from: {} };
    const skills = { skills: "ro" as const, instructions: "rw" as const, skillsFolder: "/skills" };
    store.update("p", { variables: none, skills });
    assert.deepEqual(new SbxLocalStore(root).skills("p"), skills, "read back, with no keyring needed");
    store.update("p", { variables: none, skills: EMPTY_SBX_SKILLS });
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
      { user: "other", token: "later" },
    ]);
    const reread = new SbxAccountStore(root);
    assert.deepEqual(
      reread.list().map((account) => account.user),
      ["skale", "other"],
    );
    assert.equal(reread.token(first.id), "new");
    assert.equal(reread.token(reread.list()[1].id), "later");
    // Signed in from the row "other" under the name sbx gives: that row is renamed, never doubled.
    const other = reread.list()[1];
    assert.equal(reread.add("Other", "renamed", other.id).id, other.id);
    assert.deepEqual(
      reread.list().map((account) => account.user),
      ["skale", "Other"],
    );
    // A row of another spelling beside a kept one of sbx's name: merged into the kept one.
    const typed = reread.add("SKALE", "typed");
    assert.equal(reread.add("skale", "merged", typed.id).id, first.id);
    assert.deepEqual(
      reread.list().map((account) => account.user),
      ["skale", "Other"],
    );
    assert.equal(reread.token(first.id), "merged");
  });
});

describe("who sbx says is signed in", () => {
  it("is read off `sbx login`'s line, and nothing else", () => {
    assert.equal(parseSignedInUser("You are signed in [username: jdoe]\n"), "jdoe");
    assert.equal(parseSignedInUser("Not authenticated to Docker\n"), undefined);
    assert.equal(parseSignedInUser(""), undefined);
  });
});

describe("what sbx said on failing", () => {
  const failed = (stderr: string) => ({ ok: false, code: 1, stdout: "", stderr });

  it("is its last line, without the ERROR prefix", () => {
    assert.equal(sbxError(failed("Starting sandboxd daemon...\nERROR: Not authenticated to Docker\n")), "Not authenticated to Docker");
    assert.equal(sbxError(failed("")), "");
  });

  it("keeps only the end of a line too long for a message", () => {
    const banner = "=== sbx v0.46.0 starting sandboxd at 2026-10-02T07:06:20Z === ".repeat(20);
    const error = sbxError(failed(`${banner}error: another daemon is already running (state dir is locked)`));
    assert.ok(error.startsWith("…"));
    assert.ok(error.endsWith("error: another daemon is already running (state dir is locked)"));
    assert.ok(error.length <= 301);
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
      { resource_type: "filesystem:write", decision: "allow", resources: ["/**"], status: "active" },
    ],
    organization: "prehcmservice",
  });
  const local = JSON.stringify({
    rules: [
      { resource_type: "filesystem:read", decision: "allow", resources: ["**"], status: "active" },
      { resource_type: "filesystem:write", decision: "allow", resources: ["**"], status: "active" },
    ],
  });
  const win32 = { platform: WINDOWS, home: "C:\\Users\\saka" };
  const posix = { platform: LINUX, home: "/home/saka" };
  const rules = (entries: object[]) => parseFilesystemRules(JSON.stringify({ rules: entries }));
  const allow = (type: string, resource: string) => ({ resource_type: type, decision: "allow", resources: [resource] });

  it("reads only active rules, and nothing out of what is not JSON", () => {
    assert.equal(parseFilesystemRules(governed).length, 2);
    assert.deepEqual(parseFilesystemRules("Not authenticated"), []);
  });

  it("reads the JSON before a notice sbx appends to stdout", () => {
    const banner = "\n╭──╮\n│ Docker Sandboxes Update Available │\n│ v0.45.1  →  v0.46.0 │\n╰──╯\n";
    assert.equal(parseFilesystemRules(governed + banner).length, 2);
    assert.deepEqual(parsePublishedPorts(`[{"host_port":1,"sandbox_port":2}]${banner}`), [{ host: "1", container: "2" }]);
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
    assert.ok(
      isMountAllowed(rules([allow("filesystem:write", "~\\.tet\\projects\\**")]), "C:\\Users\\saka\\.tet\\projects\\p", "rw", win32),
    );
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "~/**")]), "/home/saka/tet", "rw", posix));
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "*:\\data\\**")]), "E:\\data\\x", "rw", win32));
    assert.ok(isMountAllowed(rules([allow("filesystem:write", "c:\\USERS\\**")]), "C:\\Users\\saka", "rw", win32));
    assert.ok(!isMountAllowed(rules([allow("filesystem:write", "/Home/**")]), "/home/saka", "rw", posix));
  });

  it("needs write for read-write, and lets a deny outrank every allow", () => {
    const readOnly = rules([allow("filesystem:read", "/data/**")]);
    assert.ok(isMountAllowed(readOnly, "/data/x", "ro", posix));
    assert.ok(!isMountAllowed(readOnly, "/data/x", "rw", posix));
    const denied = rules([
      allow("filesystem", "/**"),
      { resource_type: "filesystem:read", decision: "deny", resources: ["/data/secret/**"] },
    ]);
    assert.ok(isMountAllowed(denied, "/data/open", "rw", posix));
    assert.ok(!isMountAllowed(denied, "/data/secret/x", "ro", posix));
    assert.ok(!isMountAllowed(denied, "/data/secret/x", "rw", posix), "a read deny stops a writable mount too");
  });
});

describe("sbx's governance", () => {
  it("names the organization of a governed account, nothing for an ungoverned one", () => {
    // `sbx policy ls --json` on an organization-governed account.
    const governed = JSON.stringify({
      rules: [],
      organization: "prehcmservice",
      last_synced_status: "ok",
      last_synced_message: "[OK] last synced 08:18:18",
    });
    assert.equal(parseGovernance(governed), "prehcmservice");
    assert.equal(parseGovernance(JSON.stringify({ rules: [], organization_unavailable: true })), "unknown organization (lookup failed)");
    assert.equal(parseGovernance(JSON.stringify({ rules: [] })), undefined);
    assert.equal(parseGovernance("not json"), undefined);
  });
});

describe("sbx's version", () => {
  it("is supported from 0.48 on, whose CLI and --json documents TET reads", () => {
    for (const [printed, supported] of [
      ["0.45.1", false],
      ["0.47.0", false],
      ["0.48.0", true],
      ["0.49.0", true],
      ["1.0.0", true],
    ] as const) {
      assert.equal(sbxVersionSupported(printed), supported, printed);
    }
  });
});
