import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { HOST_SIDE, SANDBOX_SIDE } from "../../src/shared/control-side";
import * as esbuild from "esbuild";
import { PLATFORM } from "../../src/main/util/host-platform";
import { hookTrustedHash, setupCodexHooks } from "../../src/main/agents/codex/hooks";
import { hookSessionId } from "../../src/main/agents/hook-payload";
import { renderPiExtension, writePiExtension } from "../../src/main/agents/pi/extension";
import { systemPrompt } from "../../src/main/agents/system-prompt";
import { createByteThresholdCheck } from "../../src/main/agents/session-ready";
import { HOST_TARGET, SANDBOX_TARGET } from "../../src/main/agents/hook-target";
import { checkAgentInstalled } from "../../src/main/agents/install-check";
import { CONTROL_ENV, type ControlRequest } from "../../src/shared/control";
import { eventually, tempDir } from "../helpers";
import { augmentAgentPath, mergePath, npmGlobalPrefix, parseShellPath, shellInvocation, win32AgentDirs } from "../../src/main/agents/agent-path";
import { listAskModels } from "../../src/main/agents";
import type { AgentDefinition } from "../../src/main/agents/agent";
import { askAgent } from "../../src/main/agents/ask";
import type { AskModel } from "../../src/shared/types/agents";
import { commitMessageFrom } from "../../src/main/agents/commit-message";
import { piModelsFrom } from "../../src/main/agents/pi/models";

/** The agents' own pieces: hooks, readiness, the version check, PATH, the system prompt, asking. */

/**
 * A stand-in control server plus a tab's environment, for pi's generated extension to report
 * to. Reports are fire-and-forget, so a test waits for them rather than awaiting the call.
 */
async function controlChannel(): Promise<{ reports: ControlRequest[]; close: () => Promise<void> }> {
  const reports: ControlRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      reports.push(JSON.parse(body) as ControlRequest);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { stdout: "{}" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  process.env[CONTROL_ENV.port] = String((server.address() as { port: number }).port);
  process.env[CONTROL_ENV.token] = "test-token";
  process.env[CONTROL_ENV.projectId] = "p1";
  process.env[CONTROL_ENV.tabId] = "tab-1";
  return {
    reports,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function reported(reports: ControlRequest[]): string[] {
  return reports.map((report) => String(report.args.event));
}

/** The small pieces, each one edit away from silently wrong. */

describe("Codex's hook trust", () => {
  // Codex's own hash (codex/hooks.ts): a change here brings back the "Hooks need review" screen.
  it("hashes the normalized hook the way Codex does", () => {
    assert.equal(
      hookTrustedHash("stop", "sh /tet/stop.sh"),
      "sha256:a6f28d9f053daa55c22c826e6aa4ad6ef89ae292a27d171ce959231dd740be62"
    );
    assert.equal(
      hookTrustedHash("pre_tool_use", "sh /tet/q.sh", "request_user_input"),
      "sha256:dea00f0554ef543a061c8aa314c4ffa0ab80a87ea327479fb17378136dcebb24"
    );
    assert.notEqual(hookTrustedHash("stop", "sh /tet/stop.sh"), hookTrustedHash("stop", "sh /tet/stop.sh", "x"));
  });

  it("hands every hook in as one TOML value with its trust entry, quoted literally", () => {
    const args = setupCodexHooks();
    const hooks = args[args.indexOf("-c") + 1];
    assert.match(hooks, /^hooks=\{SessionStart=\[/);
    for (const event of ["UserPromptSubmit", "Stop", "PermissionRequest", "PreToolUse"]) {
      assert.ok(hooks.includes(`${event}=[`), event);
    }
    assert.match(hooks, /matcher='request_user_input'/);
    const trusted = hooks.match(/trusted_hash='sha256:[0-9a-f]{64}'/g) ?? [];
    assert.equal(trusted.length, 5, "one per event, each its own handler");
    assert.ok(!args.some((arg) => arg.startsWith("hooks.")), "one value, never key paths");
  });

  it("registers one plain tet-ctl call per event, host and sandbox alike", () => {
    for (const target of [HOST_TARGET, SANDBOX_TARGET]) {
      const hooks = setupCodexHooks(target)[1];
      for (const event of ["session-start", "prompt-submit", "stop", "permission", "question"]) {
        assert.ok(hooks.includes(`command='tet-ctl hook ${event}'`), `${event} on ${target.posix ? "posix" : "win32"}`);
      }
      // No host path in a sandbox's trust key, and nothing written.
      assert.match(hooks, target.posix ? /'\/<session-flags>\/config\.toml:/ : /'C:\\<session-flags>\\config\.toml:/);
    }
  });
});

describe("session readiness checks", () => {
  it("counts plain bytes across chunks", () => {
    const ready = createByteThresholdCheck(10);
    assert.equal(ready("12345"), false);
    assert.equal(ready("12345"), false);
    assert.equal(ready("1"), true);
  });
});

/**
 * The check runs before the workspace opens (requirements.ts), so it must answer for anything it
 * spawns. Each case hangs forever on the stdio Node gives a spawn by default.
 */
describe("an agent's version check", () => {
  /** node standing in for the agent, running `script` as its `--version`. */
  const check = (script: string): Promise<boolean> => checkAgentInstalled(process.execPath, ["-e", script], os.tmpdir());

  it("answers for a program that reads stdin, rather than waiting for input nobody sends", async () => {
    // An interactive shim, a login prompt, cmd.exe's "Terminate batch job (Y/N)?": with stdin left
    // open it reads forever. Closed, it sees EOF at once.
    assert.equal(await check('process.stdin.on("end", () => process.exit(0)); process.stdin.resume();'), true);
  });

  it("answers for a program that prints more than a pipe holds", async () => {
    // Nothing reads the child's output, so a piped stdout fills and blocks it mid-write.
    assert.equal(await check(`process.stdout.write("x".repeat(${4 * 1024 * 1024})); process.exit(0);`), true);
  });

  it("gives up on a program that never exits, counting it as missing", async () => {
    const started = Date.now();
    assert.equal(await check("setInterval(() => undefined, 1000);"), false);
    // The timeout did it, not a crash.
    assert.ok(Date.now() - started >= 9_000, `gave up after ${Date.now() - started}ms`);
  });
});

describe("the session a hook report names", () => {
  // Trimmed from what the real hooks write to stdin.
  it("is read off Claude Code's and Codex's payloads alike", () => {
    const claude = `{"session_id":"e1ddb9cf-df0f-40b3-82b2-1343910fc3e4","transcript_path":"C:\\\\x.jsonl","hook_event_name":"UserPromptSubmit","prompt":"ok"}`;
    const codex = `{"session_id":"01a09f45-f0d2-74e1-be90-a8f79f43cb7e","turn_id":"01a09f45-f15d-77e1-b1d3-5375a8ce98d5","hook_event_name":"Stop"}`;
    assert.equal(hookSessionId(claude), "e1ddb9cf-df0f-40b3-82b2-1343910fc3e4");
    assert.equal(hookSessionId(codex), "01a09f45-f0d2-74e1-be90-a8f79f43cb7e");
    for (const nothing of ["", "{}", "null", "not json", `{"session_id":"  "}`, `{"session_id":7}`]) {
      assert.equal(hookSessionId(nothing), undefined, nothing);
    }
  });
});

describe("TET's system prompt", () => {
  // It crosses cmd.exe and `sbx run`, safe only as a plain line (system-prompt.ts).
  it("stays one line of letters, digits and plain punctuation", () => {
    for (const side of [HOST_SIDE, SANDBOX_SIDE]) {
      assert.match(systemPrompt(side), /^[A-Za-z0-9 .,;:'-]+$/);
    }
  });
});

describe("pi's extension", () => {
  // pi exits outright on an extension that does not compile.
  it("compiles as TypeScript", () => {
    assert.doesNotThrow(() => esbuild.transformSync(renderPiExtension(), { loader: "ts" }));
  });

  it("reports both ends of a turn and of a question", async () => {
    const dir = tempDir("tet-pi-ext-");
    const channel = await controlChannel();
    try {
      const source = renderPiExtension();
      const compiled = path.join(dir, "tet.js");
      fs.writeFileSync(compiled, esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code);
      const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
      (createRequire(__filename)(compiled) as { default: (pi: unknown) => void }).default({
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers[event] = handler;
        }
      });

      assert.equal(handlers.before_agent_start, undefined, "the system prompt comes from pi's own flag");
      const ctx = { sessionManager: { getSessionId: () => "019eba31-566c-7911-bf09-14afe53d7c36" } };
      handlers.agent_start({}, ctx);
      handlers.agent_settled({}, ctx);
      handlers.ui_prompt_start({}, {});
      handlers.ui_prompt_end({}, {});
      await eventually("all four reported", () => channel.reports.length === 4, 3000);
      assert.deepEqual(reported(channel.reports), ["prompt-submit", "stop", "permission", "answered"]);
      // The tab is the address; the session goes along to bind the tab to it.
      assert.deepEqual(channel.reports[0].caller, { projectId: "p1", tabId: "tab-1" });
      assert.equal(hookSessionId(String(channel.reports[0].args.payload)), "019eba31-566c-7911-bf09-14afe53d7c36");
      assert.equal(hookSessionId(String(channel.reports[2].args.payload)), undefined, "a context without a session");
      assert.equal(channel.reports[0].verb, "hook");
      // Reports are not awaited and race; tet orders them by the time each carries.
      assert.ok(
        channel.reports.every((report) => typeof report.at === "number" && report.at > 0),
        "every report says when it was made"
      );
      // A worktree's tab: its token is made with the key, so a report without it is refused.
      process.env[CONTROL_ENV.worktree] = "k1";
      handlers.agent_start({}, ctx);
      await eventually("the worktree's report", () => channel.reports.length === 5, 3000);
      assert.deepEqual(channel.reports[4].caller, { projectId: "p1", worktree: "k1", tabId: "tab-1" });
    } finally {
      delete process.env[CONTROL_ENV.worktree];
      await channel.close();
    }
  });

  // Written on the host, read inside a container too: nothing in it may depend on where it runs.
  it("writes one file that reads the channel from its environment", () => {
    const storageDir = tempDir("tet-pi-sbx-");
    const file = writePiExtension(storageDir);
    const source = fs.readFileSync(file, "utf8");

    assert.equal(file, path.join(storageDir, "tet", "index.ts"), "pi lists it by its folder's name");
    assert.deepEqual(fs.readdirSync(path.join(storageDir, "tet")), ["index.ts"], "no notify script, no marker directories");
    assert.ok(source.includes(JSON.stringify(CONTROL_ENV)), "the channel is read from the environment, not baked in");
  });
});

describe("the agent PATH", () => {
  it("appends only new directories, keeps order, and leaves an unchanged PATH alone", () => {
    assert.equal(mergePath("/a:/b", ["/c", "/b"], ":"), "/a:/b:/c", "the new one added, the present one not");
    assert.equal(mergePath("/a:/b", ["/b", "/a"], ":"), "/a:/b", "all present — the very same string");
    assert.equal(mergePath("", ["/a"], ":"), "/a", "an empty PATH takes the addition alone, no leading delimiter");
    assert.equal(mergePath("/a", [], ":"), "/a", "nothing to add");
    // The unix call: the shell's PATH is the base, so its node comes before the distro's.
    assert.equal(mergePath("/nvm/bin:/usr/bin", "/usr/bin:/usr/local/bin".split(":"), ":"), "/nvm/bin:/usr/bin:/usr/local/bin");
  });

  it("asks a Bourne shell as login and interactive, and csh the one way it allows", () => {
    assert.equal(shellInvocation("/bin/zsh")[0], "-ilc");
    assert.match(shellInvocation("/bin/zsh")[1], /^command printf/);
    assert.equal(shellInvocation("/bin/tcsh")[0], "-ic");
    assert.match(shellInvocation("/bin/tcsh")[1], /^printf/);
  });

  it("reads a moved npm prefix from the environment before ~/.npmrc, and nothing from neither", () => {
    assert.equal(npmGlobalPrefix({ NPM_CONFIG_PREFIX: "D:\\env" }, "prefix=D:\\rc"), "D:\\env");
    assert.equal(npmGlobalPrefix({}, "registry=https://x\r\n  prefix = D:\\rc  \r\n"), "D:\\rc");
    assert.equal(npmGlobalPrefix({ HOME: "D:\\h" }, "prefix=${HOME}\\npm"), "D:\\h\\npm", "expanded as npm expands it");
    assert.equal(npmGlobalPrefix({}, "prefix=${GONE}\\npm"), "${GONE}\\npm", "an unset variable stays, as in npm");
    assert.equal(npmGlobalPrefix({}, undefined), undefined);
  });

  it("reads the PATH the login shell printed between the markers, ignoring the noise around it", () => {
    assert.equal(parseShellPath("motd\n__TET_PATH_START__/usr/bin:/opt/bin__TET_PATH_END__\n"), "/usr/bin:/opt/bin");
    assert.equal(parseShellPath("a login banner with no markers"), undefined);
  });

  it("names npm's reported prefix, the manager roots from the environment, and the fixed shim dirs", () => {
    const j = (...p: string[]): string => p.join(path.sep);
    // Every manager's variable, plus npm's reported (moved) prefix.
    const full = win32AgentDirs(
      { APPDATA: j("C:", "u", "AppData", "Roaming"), LOCALAPPDATA: j("C:", "u", "AppData", "Local"), USERPROFILE: j("C:", "u"), NVM_SYMLINK: j("C:", "nvm", "node"), VOLTA_HOME: j("C:", "volta"), SCOOP: j("C:", "scoop") },
      j("D:", "npm-global")
    );
    assert.deepEqual(full, [
      j("D:", "npm-global"),
      j("C:", "u", "AppData", "Roaming", "npm"),
      j("C:", "nvm", "node"),
      j("C:", "volta", "bin"),
      j("C:", "scoop", "shims"),
      j("C:", "u", "AppData", "Local", "Microsoft", "WinGet", "Links"),
      j("C:", "u", "AppData", "Local", "DockerSandboxes", "bin")
    ]);
    // Nothing exported, no npm answer: the managers' default roots.
    const defaults = win32AgentDirs({ APPDATA: j("C:", "Roaming"), LOCALAPPDATA: j("C:", "Local"), USERPROFILE: j("C:", "u") }, undefined);
    assert.deepEqual(defaults, [
      j("C:", "Roaming", "npm"),
      j("C:", "Local", "Volta", "bin"),
      j("C:", "u", "scoop", "shims"),
      j("C:", "Local", "Microsoft", "WinGet", "Links"),
      j("C:", "Local", "DockerSandboxes", "bin")
    ]);
    // No empty entries.
    assert.deepEqual(win32AgentDirs({}, undefined), []);
  });

  // The login shell is asked to be interactive, and an interactive shell ignores SIGTERM: the
  // timeout must not rely on it, or the requirements check waits forever and the app never opens.
  it("gives up on a login shell that ignores being asked to stop", { skip: PLATFORM.agentDirsKnown && "posix only", timeout: 30_000 }, async () => {
    const dir = tempDir("tet-shell-");
    const shell = path.join(dir, "hanging-shell");
    // Ignores SIGTERM and blocks in the shell itself, with no child to kill in its place.
    fs.writeFileSync(shell, ["#!/bin/sh", 'trap "" TERM', "read ignored", ""].join("\n"), { mode: 0o755 });
    const shellBefore = process.env.SHELL;
    const pathBefore = process.env.PATH;
    process.env.SHELL = shell;
    const started = Date.now();
    try {
      await augmentAgentPath();
    } finally {
      if (shellBefore === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = shellBefore;
      }
    }
    const took = Date.now() - started;
    assert.ok(took < 20_000, `it waited ${took}ms on a shell it had given up on`);
    assert.equal(process.env.PATH, pathBefore, "a shell that answered nothing changes nothing");
  });
});

describe("a background agent question", () => {
  it("arrives on stdin and returns trimmed stdout", async () => {
    const script = [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => process.stdout.write('  ' + input.toUpperCase() + '  '));"
    ].join(" ");
    assert.equal(await askAgent(os.tmpdir(), process.execPath, ["-e", script], "first\nsecond"), "FIRST\nSECOND");
  });
});

describe("pi's model listing", () => {
  it("reads each row of its table as provider/model", () => {
    const output = [
      "provider    model                            context  max-out  thinking  images",
      "openrouter  ~anthropic/claude-sonnet-latest  1M       128K     yes       yes   ",
      "anthropic   claude-haiku                     200K     64K      yes       yes   ",
      ""
    ].join("\n");
    assert.deepEqual(piModelsFrom(output), [
      { id: "openrouter/~anthropic/claude-sonnet-latest", label: "openrouter/~anthropic/claude-sonnet-latest" },
      { id: "anthropic/claude-haiku", label: "anthropic/claude-haiku" }
    ]);
  });

  it("lists nothing without its table", () => {
    assert.deepEqual(piModelsFrom("No models available. Set an API key.\n"), []);
  });
});

describe("a suggested commit message", () => {
  it("takes a plain subject unchanged", () => {
    assert.equal(commitMessageFrom("fix terminal focus"), "fix terminal focus");
  });

  it("tolerates a fence, label and wrapping quotes", () => {
    assert.equal(commitMessageFrom('```text\nCommit message: "add commit suggestions"\n```'), "add commit suggestions");
  });

  it("rejects an empty or fence-only answer", () => {
    assert.equal(commitMessageFrom("\n```\n```\n"), "");
  });
});

describe("the models the commit prompt offers", () => {
  /** An agent asking through `executable`, whose model listing is `models`. */
  const asking = (executable: string, models?: () => Promise<AskModel[]>): AgentDefinition =>
    ({
      id: "fake",
      displayName: "Fake",
      executable: () => executable,
      install: { versionArgs: ["--version"] },
      ask: models && { args: [], modelArgs: () => [], models }
    }) as unknown as AgentDefinition;

  it("are the agent's own where it is installed", async () => {
    const models = [{ id: "m1", label: "M1" }];
    assert.deepEqual(await listAskModels(asking(process.execPath, async () => models), os.tmpdir()), { models });
  });

  it("are none, with why, from an agent not installed", async () => {
    const missing = path.join(tempDir("tet-ask-models-"), "no-such-agent");
    const result = await listAskModels(asking(missing, async () => [{ id: "m1", label: "M1" }]), os.tmpdir());
    assert.deepEqual(result.models, []);
    assert.match(result.error ?? "", /Fake is not installed/);
  });

  it("are none, with the listing's own words, where it fails", async () => {
    const result = await listAskModels(asking(process.execPath, () => Promise.reject(new Error("catalog down"))), os.tmpdir());
    assert.deepEqual(result.models, []);
    assert.match(result.error ?? "", /Could not list Fake's models: catalog down/);
  });

  it("are none, without an error, from an agent that cannot ask", async () => {
    assert.deepEqual(await listAskModels(asking(process.execPath), os.tmpdir()), { models: [] });
  });
});
