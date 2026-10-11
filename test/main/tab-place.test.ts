import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentDefinition, AgentSessionInfo, SandboxedAgent, SessionProvider, SpawnPreparation } from "../../src/main/agents/agent";
import { toContainerPath } from "../../src/main/agents/hook-target";
import { sandboxName } from "../../src/main/sbx/sbx";
import { dropsDir, sandboxDir, sandboxDropsDir, sandboxSessionDir } from "../../src/main/store/project-dirs";
import type { ResolvedRef } from "../../src/main/store/resolved-ref";
import { CommandPlace, HostPlace, SandboxPlace, type PlaceContext } from "../../src/main/terminals/tab-place";
import { HOST_TAB, SANDBOX_TAB } from "../../src/main/terminals/tab-side";
import { tempDir } from "../helpers";

/** terminals/tab-place.ts: where a tab's process runs, host or sandbox, and what differs between them. */

const SESSION: AgentSessionInfo = { id: "s1", title: "first", updatedAt: 2, createdAt: 1 };

function resolvedRef(folder: string, worktree?: string): ResolvedRef {
  return { ref: { projectId: "p", worktree }, path: folder, name: () => "repo" };
}

/** A provider recording its calls as "<operation>:<arguments>". */
function recordingProvider(calls: string[], overrides: Partial<SessionProvider> = {}): SessionProvider {
  return {
    list: (cwd) => {
      calls.push(`list:${cwd}`);
      return Promise.resolve([SESSION]);
    },
    resumeArgs: (id) => ["--resume", id],
    remove: (executable, cwd, id) => {
      calls.push(`remove:${executable}:${cwd}:${id}`);
      return Promise.resolve();
    },
    rename: (executable, cwd, id, title) => {
      calls.push(`rename:${executable}:${cwd}:${id}:${title}`);
      return Promise.resolve();
    },
    files: (cwd, id) => {
      calls.push(`files:${cwd}:${id}`);
      return Promise.resolve([`${cwd}/${id}.jsonl`]);
    },
    ...overrides,
  };
}

function hostContext(root: string, sessions?: SessionProvider): PlaceContext {
  const agent = { id: "claude", sessions } as unknown as AgentDefinition;
  return { at: resolvedRef(path.join(root, "repo")), dataRoot: root, agent, executable: "claude-bin", onNotice: () => undefined };
}

describe("a host place", () => {
  it("is this machine's side, keeps drops in the project's folder and hands paths as they are", async () => {
    const root = tempDir("tet-place-");
    const place = new HostPlace(hostContext(root), () => undefined);
    assert.equal(place.side, HOST_TAB);
    assert.equal(place.dropsDir(), dropsDir(root, "p"));
    assert.deepEqual(await place.handPaths(["/a/b", "/c"]), ["/a/b", "/c"]);
  });

  it("lists no sessions for an agent that keeps none, and the agent's own for its folder", async () => {
    const root = tempDir("tet-place-");
    assert.deepEqual(await new HostPlace(hostContext(root), () => undefined).listSessions(), []);
    const calls: string[] = [];
    const place = new HostPlace(hostContext(root, recordingProvider(calls)), () => undefined);
    assert.deepEqual(await place.listSessions(), [SESSION]);
    assert.deepEqual(calls, [`list:${path.join(root, "repo")}`]);
  });

  it("offers session operations only for an agent with sessions, run against its folder and executable", async () => {
    const root = tempDir("tet-place-");
    const repo = path.join(root, "repo");
    assert.equal(new HostPlace(hostContext(root), () => undefined).sessionActions(), undefined);
    const calls: string[] = [];
    const actions = new HostPlace(hostContext(root, recordingProvider(calls)), () => undefined).sessionActions();
    assert.ok(actions);
    assert.equal(actions.root, undefined);
    await actions.remove("s1");
    await actions.rename("s1", "new");
    assert.deepEqual(await actions.files("s1"), [`${repo}/s1.jsonl`]);
    assert.deepEqual(calls, [`remove:claude-bin:${repo}:s1`, `rename:claude-bin:${repo}:s1:new`, `files:${repo}:s1`]);
  });

  it("watches only where the agent can, and says whether the watch is armed until it is stopped", () => {
    const root = tempDir("tet-place-");
    const none = new HostPlace(hostContext(root, recordingProvider([])), () => undefined);
    assert.equal(
      none.watchSessions(() => undefined),
      undefined,
    );
    assert.equal(none.sessionsWatched(), false);

    let armed = true;
    let stopped = 0;
    const place = new HostPlace(
      hostContext(
        root,
        recordingProvider([], {
          watch: () => ({
            stop: () => {
              stopped++;
            },
            watching: () => armed,
          }),
        }),
      ),
      () => undefined,
    );
    const stop = place.watchSessions(() => undefined);
    assert.ok(stop);
    assert.equal(place.sessionsWatched(), true);
    armed = false;
    assert.equal(place.sessionsWatched(), false, "a watch that could not arm leaves the listing to the tab's output");
    stop();
    assert.equal(stopped, 1);
    assert.equal(place.sessionsWatched(), false);
  });

  it("launches the agent's executable with its setup's arguments first, and reads the setup at each launch", async () => {
    const root = tempDir("tet-place-");
    let preparation: SpawnPreparation | undefined = { args: ["--settings", "x.json"], env: { A: "1" } };
    const place = new HostPlace(hostContext(root), () => preparation);
    const seen: (string[] | undefined)[] = [];
    const input = {
      agentArgs: (files: string[] | undefined) => {
        seen.push(files);
        return ["--resume", "s1"];
      },
      handover: { from: "codex" as const, sessionId: "o1", files: ["/other/o1.jsonl"] },
      onData: () => undefined,
    };
    assert.deepEqual(await place.launch(input), {
      executable: "claude-bin",
      args: ["--settings", "x.json", "--resume", "s1"],
      env: { A: "1" },
    });
    assert.deepEqual(seen, [["/other/o1.jsonl"]], "a handover's files are read where the other agent keeps them");

    preparation = undefined;
    assert.deepEqual(await place.launch({ ...input, handover: undefined }), {
      executable: "claude-bin",
      args: ["--resume", "s1"],
      env: undefined,
    });
    assert.deepEqual(seen.at(-1), undefined);
  });
});

describe("a saved command's place", () => {
  it("starts the command as it is, its variables over the machine's, and no agent setup", async () => {
    const root = tempDir("tet-place-");
    const place = new CommandPlace(hostContext(root, recordingProvider([])), { executable: "node", args: ["-e", "0"], env: { X: "y" } });
    assert.equal(place.side, HOST_TAB);
    assert.deepEqual(await place.launch(), { executable: "node", args: ["-e", "0"], envOverride: { X: "y" } });
  });
});

describe("a sandbox place", () => {
  function sandboxContext(root: string, onNotice: PlaceContext["onNotice"] = () => undefined, worktree?: string) {
    const calls: string[] = [];
    const agent = {
      id: "claude",
      sandbox: {
        sessions: {
          mounts: [{ sub: "projects", target: "/home/agent/.claude/projects", file: false }],
          at: (sessionRoot: string, cwd: string, within: string): ReturnType<NonNullable<SandboxedAgent["sandbox"]["sessions"]>["at"]> => ({
            list: () => {
              calls.push(`list:${sessionRoot}:${cwd}:${within}`);
              return Promise.resolve([SESSION]);
            },
            remove: (id) => {
              calls.push(`remove:${id}`);
              return Promise.resolve();
            },
            rename: (id, title) => {
              calls.push(`rename:${id}:${title}`);
              return Promise.resolve();
            },
            files: (id) => Promise.resolve([`${sessionRoot}/${id}.jsonl`]),
          }),
        },
      },
    } as unknown as SandboxedAgent;
    const context: PlaceContext<SandboxedAgent> = {
      at: resolvedRef(path.join(root, "repo"), worktree),
      dataRoot: root,
      agent,
      executable: "claude-bin",
      onNotice,
    };
    return { context, calls };
  }

  it("names its sandbox after the agent and the repository or worktree, and keeps its drops in the agent's folder", () => {
    const root = tempDir("tet-place-");
    const repository = new SandboxPlace(sandboxContext(root).context);
    const worktree = new SandboxPlace(sandboxContext(root, undefined, "wt").context);
    assert.equal(repository.side, SANDBOX_TAB);
    assert.equal(repository.sandbox, sandboxName({ projectId: "p" }, "claude"));
    assert.equal(repository.name, repository.sandbox);
    assert.notEqual(worktree.name, repository.name, "a worktree's sandbox is its own");
    assert.equal(repository.dropsDir(), sandboxDropsDir(sandboxDir(root, { projectId: "p" }, "claude")));
  });

  it("lists its sessions through the mounted folder with the container path, each named with the sandbox", async () => {
    const root = tempDir("tet-place-");
    const { context, calls } = sandboxContext(root);
    const place = new SandboxPlace(context);
    const agentDir = sandboxDir(root, { projectId: "p" }, "claude");
    assert.deepEqual(await place.listSessions(), [{ ...SESSION, sandbox: place.name }]);
    assert.deepEqual(calls, [`list:${sandboxSessionDir(agentDir)}:${toContainerPath(path.join(root, "repo"))}:${agentDir}`]);
  });

  it("keeps no sessions and no session operations for an agent without them in a sandbox", async () => {
    const root = tempDir("tet-place-");
    const { context } = sandboxContext(root);
    delete (context.agent.sandbox as { sessions?: unknown }).sessions;
    const place = new SandboxPlace(context);
    assert.deepEqual(await place.listSessions(), []);
    assert.equal(place.sessionActions(), undefined);
  });

  it("offers session operations bound to its agent folder, which a file must not lead out of", async () => {
    const root = tempDir("tet-place-");
    const { context, calls } = sandboxContext(root);
    const actions = new SandboxPlace(context).sessionActions();
    assert.ok(actions);
    assert.equal(actions.root, sandboxDir(root, { projectId: "p" }, "claude"));
    await actions.remove("s1");
    await actions.rename("s1", "new");
    assert.deepEqual(calls, ["remove:s1", "rename:s1:new"]);
  });

  it("watches nothing: a sandboxed tab's own output schedules the listing", () => {
    const place = new SandboxPlace(sandboxContext(tempDir("tet-place-")).context);
    const watched = (): unknown => place.watchSessions();
    assert.equal(watched(), undefined);
    assert.equal(place.sessionsWatched(), false);
  });

  it("hands a path its workspace or agent folder already holds at its container path, saying nothing", async () => {
    const root = tempDir("tet-place-");
    const notices: string[] = [];
    const place = new SandboxPlace(sandboxContext(root, (_severity, message) => notices.push(message)).context);
    const inside = [path.join(root, "repo", "src", "a.ts"), path.join(sandboxDir(root, { projectId: "p" }, "claude"), "drops", "b.png")];
    assert.deepEqual(await place.handPaths(inside), inside.map(toContainerPath));
    assert.deepEqual(notices, []);
  });
});
