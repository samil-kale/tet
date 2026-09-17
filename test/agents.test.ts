import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { getAgent } from "../src/main/agents";
import type { AgentDefinition, AgentSessionInfo } from "../src/main/agents/agent";
import { askAgent } from "../src/main/agents/ask";
import { registerAgentDir } from "../src/main/agents/opencode/sessions";
import { ensureRunning, execInSandbox, pathMountSpecs, SBX_VERIFIED_VERSION } from "../src/main/sbx";
import { parseFilesystemRules } from "../src/main/sbx-policy";
import { agentDirFor } from "../src/main/terminals/agent-data";
import { toContainerPath } from "../src/main/terminals/hook-target";
import { resolveCommand } from "../src/main/terminals/pty";
import { UNCAUGHT_MARKER } from "../src/main/uncaught";
import type { ControlEvent } from "../src/shared/control";
import { SBX_AGENT_IDS, type Project, type SbxAgentId, type TerminalDescriptor } from "../src/shared/types";
import { eventually, killApp, startApp, tetCtl, type TestApp } from "./helpers";

/**
 * The agents' CLIs and sbx as installed on this machine, measured again the way tet uses them —
 * what the AgentDefinitions and sbx.ts hold as measured. Run it before relying on an update.
 *
 * Only on a machine where they are installed and signed in, each part on its own switch:
 * - TET_AGENT_TEST=1: every agent in a tab of the real app, driven through tet-ctl. Spends model
 *   tokens, one short prompt and one background question per agent.
 * - TET_SBX_TEST=1: sbx's own commands on one throwaway sandbox, no agent run in it — the agents
 *   are the other switch's.
 *
 * A version other than `verifiedVersion` (SBX_VERIFIED_VERSION) is reported, not failed; once a run
 * passes on it, it goes there.
 *
 * Leaves behind what the CLIs record themselves: AGENT_REPO as a folder the user trusts (Claude
 * Code, Codex). Sessions go with their tabs, the sandbox and its rules with `sbx rm`.
 */

const HOST = process.env.TET_AGENT_TEST === "1";
const SBX = process.env.TET_SBX_TEST === "1";

/** Run as tet runs a command: no shell, a win32 shim through cmd.exe. Blocks the event loop. */
function run(command: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: os.tmpdir(),
    encoding: "utf8",
    input,
    windowsHide: true,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function versionIn(text: string): string | undefined {
  return /\d+\.\d+\.\d+/.exec(text)?.[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the agents as installed", { skip: !HOST && "TET_AGENT_TEST=1 only" }, () => {
  const TOKEN = "agents-test-token";
  const STARTUP_MS = 60_000;
  const TURN_MS = 3 * 60_000;
  const ASK_MS = 5 * 60_000;
  /** The same path every run, so the trust a CLI records for it is recorded once. */
  const AGENT_REPO = path.join(os.tmpdir(), "tet-agents-test");

  /**
   * The question a CLI asks in a folder it has not been trusted with, as `tabs-output` shows
   * it (spaces may be gone), and the keys answering "trust". Measured 2026-09-16, win32: Claude
   * Code 2.1.273 preselects "No, exit", Codex 0.154.0 "1. Yes, continue"; opencode and pi ask nothing.
   */
  const TRUST_QUESTIONS: Partial<Record<SbxAgentId, { asked: RegExp; keys: string[] }>> = {
    claude: { asked: /Yes,\s*I\s*trust\s*this\s*folder/, keys: ["\x1b[B", "\r"] },
    codex: { asked: /Do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*directory/, keys: ["\r"] }
  };
  /** How long a CLI's first frame is watched for that question. */
  const TRUST_WAIT_MS = 15_000;

  /** Answerable only from TET's system prompt, which names the tool; the prompt itself does not. */
  const PROMPT = "Which command-line tool does your system prompt say controls TET? Reply with only its name.";
  const RENAMED = "tet agents test";

  /** `tabs-list` answers the manager's inspection, which adds this to a descriptor. */
  type ListedTab = TerminalDescriptor & { reportedSessionId?: string };

  let userData: string;
  let app: TestApp | undefined;
  let project: Project | undefined;

  /**
   * The name, in the output with everything but letters and digits taken out: a TUI draws a word in
   * pieces between its spinner's frames (measured, opencode 1.18.4: "t⬝⬝⬝⬝⬝⬝⬝⬝et-ctl").
   */
  function answered(output: string): boolean {
    return output.replace(/[^a-z0-9]/gi, "").includes("tetctl");
  }

  function ctl(...args: string[]) {
    assert.ok(app, "tet started");
    return app.ctl(...args);
  }

  function currentProject(): Project {
    assert.ok(project, "the repository added");
    return project;
  }

  async function tabOf(tabId: string): Promise<ListedTab | undefined> {
    const tabs = (await ctl("tabs-list", "--project", currentProject().id)).result as ListedTab[] | undefined;
    return tabs?.find((entry) => entry.tabId === tabId);
  }

  /** Read as a tab of the project does: the verb answers only there. */
  async function outputOf(tabId: string): Promise<string> {
    assert.ok(app, "tet started");
    const read = await tetCtl(["tabs-output", tabId, "--kb", "64"], app.asTab(currentProject().id, tabId));
    return (read.result as { output: string } | undefined)?.output ?? "";
  }

  async function send(tabId: string, text: string): Promise<void> {
    const sent = await ctl("tabs-send", tabId, text, "--project", currentProject().id);
    assert.equal(sent.status, 0, sent.stderr);
  }

  async function pressEnter(tabId: string): Promise<void> {
    const sent = await ctl("tabs-send", tabId, "--enter", "--project", currentProject().id);
    assert.equal(sent.status, 0, sent.stderr);
  }

  async function hookEventsOf(tabId: string, since: number): Promise<ControlEvent[]> {
    const events = (await ctl("events-tail", "--tail", "200", "--project", currentProject().id)).result as ControlEvent[];
    return events.filter((event) => event.tabId === tabId && event.kind === "hook" && event.at >= since);
  }

  /** The sessions as tet lists them, read here straight from where the CLI keeps them. */
  function listSessions(agent: AgentDefinition): Promise<AgentSessionInfo[]> {
    assert.ok(agent.sessions, `${agent.displayName} has sessions`);
    // opencode's listing is its plugin's records, found through what prepareSpawn registered in the app.
    registerAgentDir(currentProject().path, agentDirFor(userData, agent.id, currentProject().id));
    return agent.sessions.list(agent.executable(), currentProject().path);
  }

  before(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "tet-agents-"));
    fs.rmSync(AGENT_REPO, { recursive: true, force: true, maxRetries: 5 });
    fs.mkdirSync(AGENT_REPO, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: AGENT_REPO });
    app = await startApp(userData, TOKEN, STARTUP_MS);
    const added = await ctl("projects-add", AGENT_REPO);
    assert.equal(added.status, 0, added.stderr);
    project = added.result as Project;
  });

  after(async () => {
    const pid = await app?.alive();
    if (pid !== undefined) {
      killApp(pid);
    }
    await eventually("tet gone", async () => (await app?.alive()) === undefined, 10_000).catch(() => undefined);
    for (const dir of [userData, AGENT_REPO]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
    const stderr = app?.stderr() ?? "";
    const uncaught = stderr.indexOf(UNCAUGHT_MARKER);
    if (uncaught >= 0) {
      assert.fail(`tet reported an uncaught exception:
${stderr.slice(uncaught)}`);
    }
  });

  for (const agentId of SBX_AGENT_IDS) {
    const agent = getAgent(agentId);

    // One tab's life, in order: each step needs the one before.
    describe(agent.displayName, () => {
      const state: { tabId?: string; sessionId?: string } = {};
      const startedTab = (): string => {
        assert.ok(state.tabId, "the tab started");
        return state.tabId;
      };

      it("is the version last verified, or says which it is", (t) => {
        assert.ok(agent.versionArgs, "a version check");
        const result = run(agent.executable(), agent.versionArgs);
        const installed = versionIn(result.stdout);
        assert.ok(installed, `${agent.displayName} installed and printing its version: ${result.stdout}${result.stderr}`);
        if (installed !== agent.verifiedVersion) {
          t.diagnostic(`${agent.displayName} ${installed} is installed, ${agent.verifiedVersion} was verified: record it once this run passes`);
        }
      });

      it("starts, draws its first frame and is trusted with the repository", { timeout: STARTUP_MS + TRUST_WAIT_MS + 30_000 }, async (t) => {
        const created = await ctl("tabs-create", "--agent", agentId, "--project", currentProject().id);
        assert.equal(created.status, 0, created.stderr);
        const tabId = (created.result as TerminalDescriptor).tabId;
        state.tabId = tabId;
        let last: ListedTab | undefined;
        await eventually(
          () => `${agent.displayName}'s first frame, last seen as ${JSON.stringify(last)}`,
          async () => {
            last = await tabOf(tabId);
            if (last?.status === "error" || last?.status === "stopped") {
              const notices = (await ctl("notices-list")).result;
              assert.fail(`${agent.displayName} ended: ${JSON.stringify(last)}\nnotices: ${JSON.stringify(notices)}\n${await outputOf(tabId)}`);
            }
            return last?.status === "running" && last.starting !== true;
          },
          STARTUP_MS
        );

        const trust = TRUST_QUESTIONS[agentId];
        if (trust) {
          const deadline = Date.now() + TRUST_WAIT_MS;
          while (Date.now() < deadline && !trust.asked.test(await outputOf(tabId))) {
            await sleep(500);
          }
          if (trust.asked.test(await outputOf(tabId))) {
            for (const key of trust.keys) {
              await send(tabId, key);
              await sleep(300);
            }
            t.diagnostic(`answered ${agent.displayName}'s trust question`);
            // The CLI draws its real frame after the answer.
            await sleep(3000);
          }
        }
      });

      it("reports both ends of a turn, names its session and knows TET's system prompt", { timeout: TURN_MS + 30_000 }, async () => {
        const tabId = startedTab();
        const since = Date.now();
        await send(tabId, PROMPT);
        // Apart from the text: typed in one write, a TUI may take the Enter as part of a paste.
        await sleep(500);
        await pressEnter(tabId);
        let last: ListedTab | undefined;
        let events: ControlEvent[] = [];
        let output = "";
        await eventually(
          () => `the turn's end, events ${JSON.stringify(events)}, tab ${JSON.stringify(last)}, output ending in:\n${output.slice(-3000)}`,
          async () => {
            last = await tabOf(tabId);
            events = await hookEventsOf(tabId, since);
            output = await outputOf(tabId);
            if (last?.waitingAt !== undefined) {
              assert.fail(`${agent.displayName} stopped for the user instead of answering:\n${output}`);
            }
            return events.some((event) => event.event === "stop") && last?.busy === false;
          },
          TURN_MS
        );
        assert.ok(events.some((event) => event.event === "prompt-submit"), `a prompt-submit among ${JSON.stringify(events)}`);
        if (agentId === "codex") {
          // Codex fires SessionStart with the first prompt: TET's system prompt rides on its answer.
          assert.ok(events.some((event) => event.event === "session-start"), `a session-start among ${JSON.stringify(events)}`);
        }
        const sessionId = last?.reportedSessionId;
        assert.ok(sessionId, "a hook named the session");
        for (const event of events) {
          assert.equal(event.sessionId, sessionId, `${event.event} names the same session`);
        }
        state.sessionId = sessionId;
        await eventually(() => `an answer naming tet-ctl in:\n${output}`, async () => answered((output = await outputOf(tabId))), 10_000);
      });

      it("lists its session with a title", { timeout: 90_000 }, async () => {
        const tabId = startedTab();
        let last: ListedTab | undefined;
        await eventually(
          () => `the tab claiming session ${state.sessionId} with a title, last seen as ${JSON.stringify(last)}`,
          async () => {
            last = await tabOf(tabId);
            return last?.sessionId !== undefined && last.sessionId === state.sessionId && last.title.trim() !== "";
          },
          60_000
        );
      });

      it("renames its session where the CLI keeps the name", { timeout: 60_000 }, async () => {
        const tabId = startedTab();
        const renamed = await ctl("tabs-rename", tabId, RENAMED, "--project", currentProject().id);
        assert.equal(renamed.status, 0, renamed.stderr);
        let sessions: AgentSessionInfo[] = [];
        let notices: unknown;
        await eventually(
          () => `session ${state.sessionId} titled "${RENAMED}" in ${JSON.stringify(sessions)}; notices ${JSON.stringify(notices)}`,
          async () => {
            sessions = await listSessions(agent);
            notices = (await ctl("notices-list")).result;
            return sessions.some((session) => session.id === state.sessionId && session.title === RENAMED);
          },
          30_000
        );
        assert.doesNotMatch(JSON.stringify(notices), /Could not rename/);
      });

      it("closes, and its session goes with the tab", { timeout: 90_000 }, async () => {
        const tabId = startedTab();
        const closed = await ctl("tabs-close", tabId, "--project", currentProject().id);
        assert.equal(closed.status, 0, closed.stderr);
        await eventually("the tab gone", async () => (await tabOf(tabId)) === undefined, 30_000);
        let sessions: AgentSessionInfo[] = [];
        await eventually(
          () => `session ${state.sessionId} gone from ${JSON.stringify(sessions)}`,
          async () => {
            sessions = await listSessions(agent);
            return !sessions.some((session) => session.id === state.sessionId);
          },
          60_000
        );
      });

      it("answers a background question and leaves no session", { timeout: ASK_MS + 60_000 }, async () => {
        assert.ok(agent.askArgs, "ask arguments");
        const known = (await listSessions(agent)).map((session) => session.id);
        const reply = await askAgent(AGENT_REPO, agent.executable(), agent.askArgs, "Reply with only the word pong.");
        assert.match(reply, /pong/i);
        await agent.cleanupAsk?.(agent.executable(), AGENT_REPO);
        const left = (await listSessions(agent)).filter((session) => !known.includes(session.id));
        assert.deepEqual(left, [], "no session left for a tab");
      });
    });
  }
});

describe("sbx as installed", { skip: !SBX && "TET_SBX_TEST=1 only" }, () => {
  /** Only ever this test's: removed before and after. */
  const NAME = "tet-sbx-test";
  const WORKSPACE = path.join(os.tmpdir(), "tet-sbx-test");
  /** Outside the workspace, which is mounted whole and would show the files either way. */
  const MOUNTS = path.join(os.tmpdir(), "tet-sbx-test-mounts");
  const CREATE_MS = 10 * 60_000;

  function sbx(...args: string[]) {
    return run("sbx", args);
  }

  function inSandbox(script: string) {
    return sbx("exec", "-i", NAME, "sh", "-c", script);
  }

  before(() => {
    sbx("rm", NAME, "--force");
    for (const dir of [WORKSPACE, MOUNTS]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
    fs.mkdirSync(WORKSPACE, { recursive: true });
    fs.mkdirSync(path.join(MOUNTS, "rw"), { recursive: true });
    fs.mkdirSync(path.join(MOUNTS, "ro"), { recursive: true });
    fs.writeFileSync(path.join(MOUNTS, "ro", "file.txt"), "from the host");
  });

  after(() => {
    // Its network rules go with it.
    sbx("rm", NAME, "--force");
    for (const dir of [WORKSPACE, MOUNTS]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("is the version last verified, or says which it is", (t) => {
    const result = sbx("version");
    const installed = versionIn(result.stdout);
    assert.ok(installed, `sbx installed and printing its version: ${result.stdout}${result.stderr}`);
    if (installed !== SBX_VERIFIED_VERSION) {
      t.diagnostic(`sbx ${installed} is installed, ${SBX_VERIFIED_VERSION} was verified: record it once this run passes`);
    }
  });

  it("answers the questions before a spawn in the shapes tet reads", () => {
    const listed = sbx("ls", "--json");
    assert.equal(listed.status, 0, `signed in: ${listed.stderr}`);
    assert.ok(Array.isArray((JSON.parse(listed.stdout) as { sandboxes?: unknown }).sandboxes), `sandboxes[] in ${listed.stdout}`);

    assert.equal(sbx("policy", "ls").status, 0, "a network policy set up");

    const filesystem = sbx("policy", "ls", "--type", "filesystem", "--json");
    assert.ok(parseFilesystemRules(filesystem.stdout).length > 0, `filesystem rules in ${filesystem.stdout}`);

    const checked = sbx("policy", "check", "network", "--json", "localhost:1");
    assert.equal(typeof (JSON.parse(checked.stdout) as { allowed?: unknown }).allowed, "boolean", `allowed in ${checked.stdout}`);
  });

  it("creates a sandbox for one workspace, once", { timeout: CREATE_MS }, () => {
    const created = sbx("create", "claude", WORKSPACE, "--name", NAME);
    assert.equal(created.status, 0, created.stdout + created.stderr);
    const listed = JSON.parse(sbx("ls", "--json").stdout) as { sandboxes: { name?: string; workspaces?: string[] }[] };
    assert.deepEqual(listed.sandboxes.find((sandbox) => sandbox.name === NAME)?.workspaces, [WORKSPACE]);
    const again = sbx("create", "claude", WORKSPACE, "--name", NAME);
    assert.notEqual(again.status, 0, "a second create fails");
    assert.match(again.stderr, /already exists/);
  });

  it("runs a command in the workspace's container path, and says when there is no sandbox", async () => {
    assert.equal(await ensureRunning(NAME), true);
    assert.equal((await execInSandbox(NAME, WORKSPACE, ["pwd"])).trim(), toContainerPath(WORKSPACE));
    assert.equal(await ensureRunning(`${NAME}-missing`), false);
    // opencode's session removal tells a gone sandbox by this wording.
    await assert.rejects(execInSandbox(`${NAME}-missing`, WORKSPACE, ["true"]), /sandbox '[^']*' not found/);
  });

  it("takes a launcher in ~/.local/bin, first on the PATH and run by node", () => {
    // As ensureSandboxLauncher writes tet-ctl.
    const written = run(
      "sbx",
      ["exec", "-i", NAME, "sh", "-c", "mkdir -p ~/.local/bin && cat > ~/.local/bin/tet-ctl && chmod +x ~/.local/bin/tet-ctl"],
      '#!/usr/bin/env node\nconsole.log("launcher ran");\n'
    );
    assert.equal(written.status, 0, written.stderr);
    const ran = sbx("exec", "-i", NAME, "tet-ctl");
    assert.equal(ran.stdout.trim(), "launcher ran", ran.stderr);
  });

  it("mounts read-write and read-only at the container path, and unmounts", () => {
    const readWrite = pathMountSpecs({ path: path.join(MOUNTS, "rw"), access: "rw" });
    const readOnly = pathMountSpecs({ path: path.join(MOUNTS, "ro"), access: "ro" });
    const rwTarget = toContainerPath(path.join(MOUNTS, "rw"));
    const roTarget = toContainerPath(path.join(MOUNTS, "ro"));
    for (const spec of [readWrite, readOnly]) {
      const mounted = sbx("mount", NAME, spec.mount);
      assert.equal(mounted.status, 0, mounted.stderr);
    }
    assert.equal(inSandbox(`echo from the sandbox > ${rwTarget}/file.txt`).status, 0);
    assert.equal(fs.readFileSync(path.join(MOUNTS, "rw", "file.txt"), "utf8").trim(), "from the sandbox");
    assert.equal(inSandbox(`cat ${roTarget}/file.txt`).stdout, "from the host");
    assert.notEqual(inSandbox(`echo x > ${roTarget}/other.txt`).status, 0, "read-only refuses a write");
    for (const spec of [readWrite, readOnly]) {
      const unmounted = sbx("umount", NAME, spec.unmount);
      assert.equal(unmounted.status, 0, unmounted.stderr);
    }
    assert.notEqual(inSandbox(`cat ${roTarget}/file.txt`).status, 0, "gone once unmounted");
  });

  it("publishes and unpublishes a port", async () => {
    const port = "58123:8080";
    const published = sbx("ports", NAME, "--publish", port);
    assert.equal(published.status, 0, published.stderr);
    assert.match(sbx("ports", NAME).stdout, /58123\s+8080/);
    const unpublished = sbx("ports", NAME, "--unpublish", port);
    assert.equal(unpublished.status, 0, unpublished.stderr);
    await eventually("the port gone", () => !/58123\s+8080/.test(sbx("ports", NAME).stdout), 10_000);
  });

  it("scopes network rules to the sandbox, one removal per host", () => {
    const allowed = sbx("policy", "allow", "network", "--sandbox", NAME, "example.com,example.org");
    assert.equal(allowed.status, 0, allowed.stderr);
    const ownRules = (): { decision?: string; editable?: boolean; resources?: string[] }[] =>
      (
        JSON.parse(sbx("policy", "ls", "--type", "network", "--json").stdout) as {
          rules: { scope?: string; decision?: string; editable?: boolean; resources?: string[] }[];
        }
      ).rules.filter((rule) => rule.scope === `sandbox:${NAME}` && rule.editable === true && rule.decision === "allow");
    assert.deepEqual(ownRules().flatMap((rule) => rule.resources ?? []).sort(), ["example.com", "example.org"]);
    assert.equal(sbx("policy", "rm", "network", "--sandbox", NAME, "--resource", "example.com").status, 0);
    assert.deepEqual(ownRules().flatMap((rule) => rule.resources ?? []), ["example.org"]);
    const again = sbx("policy", "rm", "network", "--sandbox", NAME, "--resource", "example.com");
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /rule not found/);
  });

  it("reaches the host's control channel over HTTP at host.docker.internal once allowed", { timeout: 60_000 }, async () => {
    const bodies: string[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        bodies.push(body);
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // tet allows `localhost:<port>` for the machine (isControlChannelAllowed); scoped to this
      // sandbox here, so the rule goes with it. The proxy rewrites host.docker.internal to localhost.
      const allowed = sbx("policy", "allow", "network", "--sandbox", NAME, `localhost:${port}`);
      assert.equal(allowed.status, 0, allowed.stderr);
      // A tet-ctl's request, as hook-report.ts makes it; async, since the server answers on this loop.
      const script =
        `const r = require("http").request({ host: "host.docker.internal", port: ${port}, method: "POST", path: "/", headers: { Connection: "close" } },` +
        ` (s) => { console.log(s.statusCode); s.resume(); }); r.on("error", (e) => console.log(e.message)); r.end("hook report");`;
      const resolved = resolveCommand("sbx", ["exec", "-i", NAME, "node", "-e", script]);
      const child = spawn(resolved.command, resolved.args, { windowsHide: true, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      await new Promise((resolve) => child.on("close", resolve));
      assert.equal(stdout.trim(), "200");
      assert.deepEqual(bodies, ["hook report"]);
    } finally {
      server.close();
    }
  });

  it("removes the sandbox", { timeout: 120_000 }, () => {
    const removed = sbx("rm", NAME, "--force");
    assert.equal(removed.status, 0, removed.stderr);
    const listed = JSON.parse(sbx("ls", "--json").stdout) as { sandboxes: { name?: string }[] };
    assert.ok(!listed.sandboxes.some((sandbox) => sandbox.name === NAME));
  });
});
