import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { HOST_SIDE, SANDBOX_SIDE } from "../../src/shared/control-side";
import { PLATFORM } from "../../src/main/util/host-platform";
import { claudeAgent } from "../../src/main/agents/claude";
import { codexHookReply } from "../../src/main/agents/codex/hooks";
import { shellAgent } from "../../src/main/agents/shell";
import { systemPrompt } from "../../src/main/agents/system-prompt";
import { findControlPort } from "../../src/main/control/control-port";
import { startControlServer } from "../../src/main/control/control-server";
import type { ControlDeps, ControlTerminals } from "../../src/main/control/control-verb";
import type { NotificationTarget } from "../../src/main/util/notifications";
import type { EnvAsk } from "../../src/main/control/env-requests";
import { tabControlToken } from "../../src/main/terminals/control-token";
import { CONTROL_ENV, CONTROL_VERBS, EXIT_CODES } from "../../src/shared/control";
import { EMPTY_REPOSITORY_STATE, type FileChange, type GitActionResult, type WorktreeInfo } from "../../src/shared/types/git";
import { type Project, type ProjectCommand, type ProjectRef, refKeyOf } from "../../src/shared/types/project";
import { EMPTY_SBX_SETTINGS, EMPTY_SBX_KNOWLEDGE, type SbxKnowledgeSettings, type SbxLocalSave, type SbxProblems, type SbxProjectSettings, type SbxStatus } from "../../src/shared/types/sbx";
import { type AppSettings, withSettings } from "../../src/shared/types/settings";
import type { TabDescriptor } from "../../src/shared/types/terminals";
import { CLI, eventually, type Run, tempDir, tetCtl as runCli } from "../helpers";
import { spawn } from "node:child_process";
import { writeLaunchers } from "../../src/main/control/control-launcher";

/**
 * The control channel below the app: the real server on a loopback port, the real CLI as a child
 * process, and everything needing electron faked behind ControlDeps.
 */

const TOKEN = "test-token";

/** Its worktrees: "four" TET made, "five" made elsewhere. */
const PROJECT: Project = {
  id: "p1",
  path: "",
  name: "one",
  worktrees: [
    { path: "/wt/four", branch: "four", key: "k4" },
    { path: "/elsewhere/five", branch: "five" }
  ]
};

const OTHER: Project = { id: "p2", path: "", name: "two", worktrees: [] };

/** PROJECT's worktree TET made. */
const WORKTREE: ProjectRef = { projectId: PROJECT.id, worktree: "k4" };

/** The worktrees of PROJECT's repository, as its repository state lists them. */
const WORKTREES: WorktreeInfo[] = [
  { path: "/repo/one", branch: "main", isRepository: true, current: false },
  { path: "/wt/four", branch: "four", base: "main", key: "k4", isRepository: false, current: false },
  { path: "/elsewhere/five", branch: "five", isRepository: false, current: false }
];

const OWN_TAB = "tab-own";

/** A tab of PROJECT whose process runs in its sbx sandbox. */
const SANDBOX_TAB = "tab-sbx";

/** The caller's own tab is a shell; "tab-2" an agent, with a session and a sandbox. */
function tab(tabId: string): TabDescriptor {
  return { tabId, agentId: tabId === OWN_TAB ? "shell" : "claude", title: "", status: "running" };
}

/** What the verbs did to the fakes. */
interface Calls {
  shown: [string, string][];
  closed: string[];
  renamed: [string, string][];
  created: string[];
  /** `[tabId, agentId, sandboxOnly]` per handover. */
  handedOff: [string, string, boolean][];
  commands: string[];
  added: string[];
  removed: string[];
  /** `[projectId, branch]` per worktree-add, `[refKey, force]` per worktree-delete. */
  worktreesAdded: [string, string][];
  worktreesDeleted: [string, boolean][];
  /** `[refKey, ref, fastForwardOnto]` per merge. */
  merges: [string, string, string | undefined][];
  /** `[tabId, hostPaths]` per path handed to a tab. */
  handed: [string, string[]][];
  shutdown: boolean[];
  desktopNotifications: [string, string, NotificationTarget | undefined][];
  hooks: [string, string, string][];
  /** Each hook's own time — see ControlRequest.at. */
  hookTimes: (number | undefined)[];
  started: string[];
  restarted: string[];
  written: [string, string][];
  editorsOpened: [string, string, boolean][];
  /** One entry per `inspect`, the call `tabs-wait` polls. */
  inspected: string[];
  /** Per `env-request`, what the dialog was asked; the names of those whose caller left. */
  envAsks: EnvAsk[];
  envWithdrawn: string[][];
  /** Per SBX Settings save, the project, the configuration and what stays on this machine. */
  sbxSaved: [string, SbxProjectSettings, SbxLocalSave][];
  /** The users sbx was signed in as with a kept access token. */
  sbxSignedIn: string[];
}

/** What the window reported for PROJECT's active editor tab, a preview, beside a kept one. */
const ACTIVE_EDITOR = { path: "a.txt", loading: false, dirty: true, readOnly: false, preview: true };

const EDITOR_LISTING = [
  { path: "b.txt", loading: false, dirty: false, readOnly: false, preview: false, active: false },
  { ...ACTIVE_EDITOR, active: true }
];

/** What `editor-list` answers for PROJECT; a.txt holds unsaved changes. */
let editorListing = EDITOR_LISTING;

/** What the faked git does for worktree-agent-merge: the branch the repository has checked out, the
 *  worktree's state, whether its merge conflicts or fails, the markers left, a fast-forward's and a
 *  delete's refusal. A conflicting merge leaves the worktree mid-merge, as git does. */
interface Merging {
  checkedOut: string;
  operation?: "merge";
  changes: FileChange[];
  merge?: "conflict" | "error";
  markers: string[];
  forwardError?: string;
  deleteRefused?: GitActionResult;
}

let merging: Merging;

/** Whether "tab-2" is mid-turn. */
let tab2Working: boolean;

/** What the window reported for the editor tabs of PROJECT's worktree. */
let worktreeEditors: typeof EDITOR_LISTING;

/** The session "tab-2" reports once set — what tabs-wait waits on. */
let tab2Session: string | undefined;

let workDir: string;

let port: number;

let server: { close: () => Promise<void> };

let settings: AppSettings;

/** Whether the faked settings patch says a theme waits for a restart. */
let themeWaits = false;

/** What the faked renameTab answers: an agent's refusal, as a real one can give. */
let refuseRename: string | undefined;

let calls: Calls;

/** The faked store: the names it keeps. */
let envNames: string[];

/** What the faked dialog answers: the names saved, undefined for Cancel, or DIALOG_STAYS_OPEN to stay
 *  up until the caller leaves. */
let dialogAnswer: string[] | undefined;

const DIALOG_STAYS_OPEN = ["(stays open)"];

/** The faked SBX Settings: sbx's status, and what a save leaves behind. */
let sbxStatus: SbxStatus;

let sbxSettings: SbxProjectSettings;

let sbxKnowledge: SbxKnowledgeSettings;

/** What the faked check finds, and so what a save leaves out. */
let sbxProblems: SbxProblems;

/** The users whose access tokens the faked store keeps; what the faked `sbx login` says on refusing,
 *  and whom it names while signed in. */
let sbxAccounts: string[];

let sbxRefusal: string | undefined;

let sbxUser: string | undefined;

/** Why the faked store could not keep a token sbx took. */
let sbxNotKept: string | undefined;

/** The terminals of the repository or a worktree, by its `refKey`. */
function terminalsOf(key: string): ControlTerminals {
  return {
    snapshot: () => [tab(OWN_TAB), tab("tab-2")],
    inspect: () => {
      calls.inspected.push(key);
      return [
        tab(OWN_TAB),
        { ...tab("tab-2"), sessionId: tab2Session, reportedSessionId: "reported-2", sandbox: "tet-claude-abc", ...(tab2Working && { inTurn: true }) }
      ];
    },
    // The caller's own tab is running: nothing to start or restart there.
    start: (tabId) => {
      calls.started.push(tabId);
      return tabId !== OWN_TAB;
    },
    restart: (tabId) => {
      calls.restarted.push(tabId);
      return tabId !== OWN_TAB;
    },
    write: (tabId, data) => {
      calls.written.push([tabId, data]);
    },
    // The caller's own tab's report, then tab-2's, which runs in the sandbox.
    events: () => [0, 1, 2, 3].map((at) => ({ at, tabId: at === 0 ? OWN_TAB : "tab-2", kind: "hook" as const, event: "stop" as const })),
    createTab: (agentId, sandboxOnly, prompt) => {
      calls.created.push(`${agentId}${sandboxOnly ? " (sandbox only)" : ""}${prompt === undefined ? "" : ` starting on "${prompt}"`}`);
      return tab("tab-new");
    },
    // The caller's own tab has no session to hand over, as a fresh one has none.
    handOver: async (tabId, agentId, sandboxOnly) => {
      calls.handedOff.push([tabId, agentId, sandboxOnly]);
      return tabId === OWN_TAB ? "This Shell tab has no session yet" : tab("tab-handover");
    },
    createCommandTab: (command: ProjectCommand) => {
      calls.commands.push(command.command);
      // Refused for a shell operator, as createCommandTab does.
      return command.command.includes("&&") ? undefined : tab("tab-cmd");
    },
    closeTabs: async (tabIds) => {
      calls.closed.push(...tabIds);
    },
    // A sandboxed tab sees the path at its container path, a host tab as it is.
    seenPaths: async (tabId, hostPaths) => {
      calls.handed.push([tabId, hostPaths]);
      return hostPaths.map((hostPath) => (tabId === SANDBOX_TAB ? `/sbx${hostPath}` : hostPath));
    },
    renameTab: async (tabId, title) => {
      calls.renamed.push([tabId, title]);
      return refuseRename;
    },
    hookEvent: (tabId, event, payload, at, side) => {
      calls.hooks.push([tabId, event, payload]);
      calls.hookTimes.push(at);
      // A Codex tab's answer, which is what a session start carries TET's system prompt in.
      const stdout = codexHookReply(event, side);
      if (tabId !== OWN_TAB) {
        return { stdout };
      }
      // As TabSessionManager.hookEvent: neither a session's start nor a prompt notifications.
      return event === "session-start" || event === "prompt-submit"
        ? { stdout }
        : { stdout, notification: { title: "Claude: Finished", body: "Finished in one" } };
    }
  };
}

function deps(): ControlDeps {
  const projects = [PROJECT, OTHER];
  const open = (ref: ProjectRef): boolean =>
    projects.some((project) => project.id === ref.projectId && (ref.worktree === undefined || project.worktrees.some((worktree) => worktree.key === ref.worktree)));
  return {
    records: {
      editor: (ref) => (refKeyOf(ref) === PROJECT.id ? ACTIVE_EDITOR : undefined),
      editors: (ref) =>
        refKeyOf(ref) === PROJECT.id ? editorListing : refKeyOf(ref) === refKeyOf(WORKTREE) ? worktreeEditors : [],
      notices: () => [{ severity: "error", message: "Could not delete", at: 1 }]
    },
    projectRefPath: (ref) => {
      const project = projects.find((entry) => entry.id === ref.projectId);
      return ref.worktree === undefined ? project?.path : project?.worktrees.find((worktree) => worktree.key === ref.worktree)?.path;
    },
    editorContent: (ref) => Promise.resolve(refKeyOf(ref) === PROJECT.id ? "edited" : undefined),
    // The worktree's window question goes unanswered.
    terminalText: (ref, tabId) =>
      Promise.resolve(refKeyOf(ref) !== PROJECT.id ? undefined : tabId === OWN_TAB ? `${"x".repeat(2048)}end` : "bold line\nnext"),
    openEditor: (ref, filePath, keep) => {
      calls.editorsOpened.push([refKeyOf(ref), filePath, keep]);
    },
    version: "1.2.3",
    pid: 4242,
    store: { list: () => projects, get: (id) => projects.find((project) => project.id === id) },
    settings: {
      get: () => settings,
      // Stands in for main.ts's settingsAccess, which applies the theme and answers whether it waits.
      patch: (edits) => {
        settings = withSettings(settings, edits);
        return themeWaits;
      }
    },
    tabManagers: {
      get: (ref) => (open(ref) ? terminalsOf(refKeyOf(ref)) : undefined)
    },
    repositories: {
      get: (ref) =>
        open(ref)
          ? {
              at: { path: refKeyOf(ref) },
              getState: () => ({
                ...EMPTY_REPOSITORY_STATE,
                head: `main-of-${refKeyOf(ref)}`,
                worktrees:
                  ref.projectId === OTHER.id ? [] : WORKTREES.map((worktree) => (worktree.isRepository ? { ...worktree, branch: merging.checkedOut } : worktree)),
                ...(ref.worktree !== undefined && { operation: merging.operation, changes: merging.changes })
              }),
              merge: async (gitRef, fastForwardOnto) => {
                calls.merges.push([refKeyOf(ref), gitRef, fastForwardOnto]);
                if (fastForwardOnto !== undefined) {
                  return merging.forwardError === undefined ? { ok: true } : { ok: false, error: merging.forwardError };
                }
                if (merging.merge === "conflict") {
                  merging.operation = "merge";
                  merging.changes = [{ path: "a.ts", status: "conflicted" }];
                  return { ok: false, error: "CONFLICT (content): Merge conflict in a.ts" };
                }
                return merging.merge === "error" ? { ok: false, error: "fatal: refusing to merge unrelated histories" } : { ok: true };
              },
              conflictMarkers: async () => merging.markers,
              listExplorer: async () => ({ files: [`${refKeyOf(ref)}.txt`], emptyDirs: [], compactFolders: true, sortOrder: "default" as const })
            }
          : undefined
    },
    listAgents: async () => [{ id: "shell", name: "Shell", installed: true }],
    agents: [claudeAgent, shellAgent],
    // Installed wherever asked: the list is the agent's own.
    askModels: async (agent) => ({ models: await agent.ask!.models(agent.executable(), "") }),
    addProject: async (directory) => {
      calls.added.push(directory);
      return directory === "/nowhere"
        ? { error: "/nowhere is not a folder" }
        : { project: { id: "p3", path: directory, name: "three", worktrees: [] } };
    },
    removeProject: async (id) => {
      calls.removed.push(id);
      return { ok: true };
    },
    addWorktree: async (projectId, branch) => {
      calls.worktreesAdded.push([projectId, branch]);
      return branch === "taken"
        ? { error: "fatal: a branch named 'taken' already exists" }
        : { project: { ...PROJECT, worktrees: [...PROJECT.worktrees, { path: `/wt/${branch}`, branch, key: "k5" }] }, worktree: "k5" };
    },
    deleteWorktree: async (worktree, force) => {
      calls.worktreesDeleted.push([refKeyOf(worktree), force]);
      return force ? { ok: true } : (merging.deleteRefused ?? { ok: true });
    },
    readCommands: async () => [{ command: "npm run build", name: "build" }, { command: "a && b" }],
    shutdown: (relaunch) => {
      calls.shutdown.push(relaunch);
    },
    showTab: (ref, tabId) => {
      calls.shown.push([refKeyOf(ref), tabId]);
    },
    showDesktopNotification: (title, body, target) => {
      calls.desktopNotifications.push([title, body, target]);
    },
    environment: {
      list: () => envNames.map((name) => ({ name, overridesMachine: name === "PATH" })),
      remove: (name) => {
        const kept = envNames.filter((entry) => entry !== name);
        const removed = kept.length < envNames.length;
        envNames = kept;
        return removed;
      }
    },
    envRequests: {
      ask: (ask, gone) => {
        calls.envAsks.push(ask);
        if (dialogAnswer !== DIALOG_STAYS_OPEN) {
          return Promise.resolve(dialogAnswer);
        }
        return new Promise((resolve) =>
          gone.addEventListener("abort", () => {
            calls.envWithdrawn.push(ask.names);
            resolve(undefined);
          })
        );
      }
    },
    sbx: {
      status: async () => ({ status: sbxStatus }),
      anyAgentInstalled: async () => true,
      settings: async () => structuredClone(sbxSettings),
      stored: () => ({ secrets: ["API_KEY"], variables: [], knowledge: structuredClone(sbxKnowledge) }),
      problems: async () => sbxProblems,
      save: async (project, request, local) => {
        calls.sbxSaved.push([project.id, request, local]);
        sbxSettings = { ...request, hosts: request.hosts.filter((host) => sbxProblems.hosts?.[host] === undefined) };
        sbxKnowledge = local.knowledge;
        return { ok: true, problems: sbxProblems };
      },
      accounts: () => sbxAccounts.map((user) => ({ id: `id-${user}`, user })),
      signedIn: async () => sbxStatus.signedIn,
      signedInUser: async () => sbxUser,
      signIn: async (account) => {
        if (sbxRefusal !== undefined) {
          return { signedIn: false, error: sbxRefusal };
        }
        calls.sbxSignedIn.push(account.user);
        sbxStatus = { ...sbxStatus, signedIn: true };
        sbxUser = account.user;
        return sbxNotKept === undefined ? { signedIn: true, account } : { signedIn: true, error: sbxNotKept };
      }
    }
  };
}

/**
 * The CLI as run from the caller's own tab of PROJECT; `env` overrides that. The token is the one a
 * tab with the resulting ids is started with, unless `env` names one.
 */
function tetCtl(args: string[], env: Record<string, string | undefined> = {}, input = ""): Promise<Run> {
  const ids = { [CONTROL_ENV.projectId]: PROJECT.id, [CONTROL_ENV.worktree]: undefined, [CONTROL_ENV.tabId]: OWN_TAB, ...env };
  const projectId = ids[CONTROL_ENV.projectId];
  const worktree = ids[CONTROL_ENV.worktree];
  const tabId = ids[CONTROL_ENV.tabId];
  const token =
    projectId === undefined && tabId === undefined
      ? TOKEN
      // The sandbox is in the token, as it is for a real tab (pty.ts's buildEnv).
      : tabControlToken(TOKEN, { projectId: projectId ?? "", worktree }, tabId ?? "", tabId === SANDBOX_TAB ? SANDBOX_SIDE : HOST_SIDE);
  return runCli(args, { [CONTROL_ENV.port]: String(port), [CONTROL_ENV.token]: token, ...ids }, input);
}

function assertRefused(run: Run, stderr: RegExp, what: string): void {
  assert.equal(run.status, EXIT_CODES.unauthorized, what);
  assert.match(run.stderr, stderr, what);
}

/** How often `help` lists `usage` as a line of its own. */
function helpLines(stdout: string, usage: string): number {
  return stdout.split("\n").filter((line) => line === `  ${usage}`).length;
}

describe("tet-ctl against the control server", () => {
  before(async () => {
    workDir = tempDir("tet-control-");
    port = await findControlPort(workDir);
    calls = {
      shown: [],
      closed: [],
      renamed: [],
      created: [],
      handedOff: [],
      commands: [],
      added: [],
      removed: [],
      worktreesAdded: [],
      worktreesDeleted: [],
      merges: [],
      handed: [],
      shutdown: [],
      desktopNotifications: [],
      hooks: [],
      hookTimes: [],
      started: [],
      restarted: [],
      written: [],
      editorsOpened: [],
      inspected: [],
      envAsks: [],
      envWithdrawn: [],
      sbxSaved: [],
      sbxSignedIn: []
    };
    server = await startControlServer(deps(), TOKEN, port);
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    settings = {
      appearance: {
        colorScheme: "system",
        darkTheme: "dark-modern",
        lightTheme: "light-modern",
        lanes: { pinned: ["projects"], order: ["projects", "git", "files"] }
      },
      notifications: { finished: true, waiting: true, idleReminder: false },
      files: { editorKeybindingPreset: "tet" },
      git: {
        checkNewChanges: false,
        pushOnCommit: false,
        deleteBranchOnRemote: false,
        deleteTagOnRemote: false,
        deleteWorktreeOnRemote: false
      },
      prompts: { texts: { commitMessage: "", handover: "" }, commitSuggester: { agentId: "", model: "" } }
    };
    for (const list of Object.values(calls)) {
      list.length = 0;
    }
    tab2Session = undefined;
    tab2Working = false;
    worktreeEditors = [];
    merging = { checkedOut: "main", changes: [], markers: [], deleteRefused: { ok: false, needsConfirmation: "uncommitted" } };
    themeWaits = false;
    refuseRename = undefined;
    envNames = ["GITLAB_TOKEN"];
    dialogAnswer = undefined;
    sbxStatus = { installed: true, signedIn: true, policyInitialized: true, blockers: [] };
    sbxSettings = { ...EMPTY_SBX_SETTINGS, enabled: true, secrets: [{ env: "API_KEY", hosts: ["api.example.com"] }] };
    sbxKnowledge = EMPTY_SBX_KNOWLEDGE;
    sbxProblems = {};
    sbxAccounts = ["skale", "work"];
    sbxRefusal = undefined;
    sbxUser = undefined;
    sbxNotKept = undefined;
  });

  it("answers help by itself, with every verb", async () => {
    const run = await tetCtl(["help"], { [CONTROL_ENV.port]: undefined, [CONTROL_ENV.host]: undefined });
    assert.equal(run.status, EXIT_CODES.ok);
    assert.match(run.stdout, /settings-set-theme <theme-id>/);
    assert.match(run.stdout, /app-restart --confirm/);
    // An agent's shell gives up on a command after its own timeout (Claude Code: 2 minutes), which
    // takes the dialog down before the user has seen it.
    assert.match(run.stdout, /env-request waits[^.]*timeout/);
    // Printed under each verb's own group (ControlVerb.group), which an unlisted one has not.
    for (const entry of CONTROL_VERBS) {
      assert.equal(helpLines(run.stdout, entry.usage), entry.unlisted ? 0 : 1, entry.verb);
    }
  });

  it("leaves the verbs a sandbox is refused out of help, and says what is missing", async () => {
    // TET_CONTROL_HOST is an sbx session's alone (sbx.ts), so the CLI needs nothing else to know.
    const run = await tetCtl(["help"], { [CONTROL_ENV.port]: undefined, [CONTROL_ENV.host]: "host.docker.internal" });
    assert.equal(run.status, EXIT_CODES.ok);
    for (const entry of CONTROL_VERBS) {
      assert.equal(helpLines(run.stdout, entry.usage), entry.sandbox !== undefined && !entry.unlisted ? 1 : 0, entry.verb);
    }
    assert.match(run.stdout, /runs in an sbx sandbox/);
  });

  it("says where it is when not inside a TET terminal", async () => {
    const run = await tetCtl(["version"], { [CONTROL_ENV.port]: undefined });
    assert.equal(run.status, EXIT_CODES.internal);
    assert.match(run.stderr, /not inside a TET terminal/);
  });

  it("refuses a wrong token", async () => {
    const run = await tetCtl(["version"], { [CONTROL_ENV.token]: "other" });
    assert.equal(run.status, EXIT_CODES.unauthorized);
    assert.match(run.stderr, /not a terminal of this TET/);
  });

  it("takes a caller's ids only with the token made for them", async () => {
    const ownToken = tabControlToken(TOKEN, { projectId: PROJECT.id }, OWN_TAB, HOST_SIDE);
    const otherProject = await tetCtl(["tabs-list"], { [CONTROL_ENV.token]: ownToken, [CONTROL_ENV.projectId]: OTHER.id });
    assertRefused(otherProject, /not a terminal of this TET/, "another project named");
    assertRefused(await tetCtl(["tabs-list"], { [CONTROL_ENV.token]: TOKEN }), /not a terminal of this TET/, "the run's token with a tab's ids");
    // A hook ends quietly whatever the answer: seen only in what reached the terminals.
    await tetCtl(["hook", "stop"], { [CONTROL_ENV.token]: ownToken, [CONTROL_ENV.tabId]: "tab-2" });
    assert.deepEqual(calls.hooks, [], "no report for a tab the caller is not");
    const bare = await tetCtl(["version"], { [CONTROL_ENV.projectId]: undefined, [CONTROL_ENV.tabId]: undefined });
    assert.equal(bare.status, EXIT_CODES.ok, "the run's token alone, as the tests' own caller");
  });

  it("refuses an unknown verb before connecting", async () => {
    const run = await tetCtl(["frobnicate"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /unknown verb: frobnicate/);
  });

  /** A raw HTTP request, bypassing the CLI, which would not send such a request. */
  async function post(body: string): Promise<string> {
    const http = await import("node:http");
    return new Promise<string>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      );
      req.end(body);
    });
  }

  it("refuses a request the server does not know, even with a valid token", async () => {
    const body = await post(JSON.stringify({ token: TOKEN, verb: "help", args: {}, caller: {} }));
    assert.equal(JSON.parse(body).error.code, "unknown_verb");
  });

  it("answers a JSON body that is not an object", async () => {
    assert.equal(JSON.parse(await post("null")).error.code, "bad_args");
  });

  it("refuses a request past the cap instead of holding it, token or not", async () => {
    // The token is only checked once the body is whole, so the cap is what stands between an
    // unauthenticated caller and this process's memory.
    for (const token of [TOKEN, "wrong"]) {
      const body = await post(JSON.stringify({ token, verb: "version", args: { pad: "x".repeat(2 * 1024 * 1024) }, caller: {} }));
      const answer = JSON.parse(body) as { error: { code: string; message: string } };
      assert.equal(answer.error.code, "bad_args", token);
      assert.match(answer.error.message, /longer than/);
    }
    // Still answering afterwards.
    assert.equal(JSON.parse(await post("null")).error.code, "bad_args");
  });

  it("takes a request just under the cap", async () => {
    const pad = "x".repeat(900 * 1024);
    const answer = JSON.parse(await post(JSON.stringify({ token: TOKEN, verb: "version", args: { pad }, caller: {} })));
    assert.equal(answer.ok, true, "a long but legitimate request is answered");
  });

  it("reports the version", async () => {
    assert.deepEqual((await tetCtl(["version"])).result, { version: "1.2.3", pid: 4242 });
  });

  it("lists the themes with their kind", async () => {
    const run = await tetCtl(["themes-list"]);
    assert.equal(run.status, EXIT_CODES.ok);
    const themes = (run.result as { id: string; kind: string }[]).map(({ id, kind }) => `${id}:${kind}`);
    assert.deepEqual(themes, [
      "dark-modern:dark",
      "dark-slate:dark",
      "dark-github:dark",
      "dark-intellij:dark",
      "dark-dracula:dark",
      "dark-claude:dark",
      "light-modern:light",
      "light-github:light",
      "light-intellij:light",
      "light-gameboy:light",
      "light-claude:light"
    ]);
  });

  it("sets a known theme for its own kind and relays whether a restart is needed, without restarting", async () => {
    const dark = await tetCtl(["settings-set-theme", "dark-slate"]);
    assert.deepEqual(dark.result, { saved: true, restartRequired: false });
    assert.equal(settings.appearance.darkTheme, "dark-slate");
    assert.equal(settings.appearance.lightTheme, "light-modern");
    themeWaits = true;
    const light = await tetCtl(["settings-set-theme", "light-modern"]);
    assert.deepEqual(light.result, { saved: true, restartRequired: true });
    assert.equal(settings.appearance.lightTheme, "light-modern");
    assert.equal(settings.appearance.colorScheme, "system", "the kind is not the theme's to change");
    assert.deepEqual(calls.shutdown, []);
  });

  it("refuses an unknown theme rather than storing it", async () => {
    const run = await tetCtl(["settings-set-theme", "solarized"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /unknown theme: solarized/);
    assert.equal(settings.appearance.darkTheme, "dark-modern");
  });

  it("sets the color scheme, relays whether a restart is needed, and refuses an unknown one", async () => {
    themeWaits = true;
    const set = await tetCtl(["settings-set-color-scheme", "light"]);
    assert.deepEqual(set.result, { saved: true, restartRequired: true });
    assert.equal(settings.appearance.colorScheme, "light");
    const unknown = await tetCtl(["settings-set-color-scheme", "sepia"]);
    assert.equal(unknown.status, EXIT_CODES.usage);
    assert.match(unknown.stderr, /unknown color scheme: sepia/);
    assert.equal(settings.appearance.colorScheme, "light");
    assert.deepEqual(calls.shutdown, []);
  });

  it("pins and unpins a lane as the window does, and refuses an unknown one", async () => {
    assert.deepEqual((await tetCtl(["settings-set-lane-pin", "files", "on"])).result, { saved: true });
    assert.deepEqual(settings.appearance.lanes, { pinned: ["projects", "files"], order: ["projects", "files", "git"] });
    await tetCtl(["settings-set-lane-pin", "projects", "off"]);
    assert.deepEqual(settings.appearance.lanes, { pinned: ["files"], order: ["files", "projects", "git"] });
    const unknown = await tetCtl(["settings-set-lane-pin", "terminals", "on"]);
    assert.equal(unknown.status, EXIT_CODES.usage);
    assert.match(unknown.stderr, /unknown lane: terminals/);
    assert.deepEqual(settings.appearance.lanes.pinned, ["files"]);
  });

  it("sets the lanes' order, keeps the pins, and refuses an unknown, a doubled or no lane", async () => {
    assert.deepEqual((await tetCtl(["settings-set-lane-order", "files", "git", "projects"])).result, { saved: true });
    assert.deepEqual(settings.appearance.lanes, { pinned: ["projects"], order: ["files", "git", "projects"] });
    for (const [args, refusal] of [
      [["files", "terminals"], /unknown lane: terminals/],
      [["git", "git"], /lane named twice: git/],
      [[], /missing lanes/]
    ] as const) {
      const refused = await tetCtl(["settings-set-lane-order", ...args]);
      assert.equal(refused.status, EXIT_CODES.usage);
      assert.match(refused.stderr, refusal);
    }
    assert.deepEqual(settings.appearance.lanes.order, ["files", "git", "projects"]);
  });

  it("sets a prompt's text, puts TET's own back without one, and refuses an unknown id", async () => {
    const set = await tetCtl(["settings-set-prompt", "commitMessage", "write a subject"]);
    assert.deepEqual(set.result, { saved: true });
    assert.equal(settings.prompts.texts.commitMessage, "write a subject");
    const reset = await tetCtl(["settings-set-prompt", "commitMessage"]);
    assert.equal(reset.status, EXIT_CODES.ok);
    assert.equal(settings.prompts.texts.commitMessage, "");
    const unknown = await tetCtl(["settings-set-prompt", "commands", "x"]);
    assert.equal(unknown.status, EXIT_CODES.usage);
    assert.match(unknown.stderr, /unknown prompt: commands/);
  });

  it("lists the keybinding presets", async () => {
    const run = await tetCtl(["keybinding-presets-list"]);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.deepEqual((run.result as { id: string; label: string }[])[0], { id: "vscode", label: "VS Code (default)" });
  });

  it("sets a known keybinding preset and refuses an unknown one rather than storing it", async () => {
    const set = await tetCtl(["settings-set-keybindings", "jetbrains"]);
    assert.deepEqual(set.result, { saved: true });
    assert.equal(settings.files.editorKeybindingPreset, "jetbrains");
    const unknown = await tetCtl(["settings-set-keybindings", "emacs"]);
    assert.equal(unknown.status, EXIT_CODES.usage);
    assert.match(unknown.stderr, /unknown keybinding preset: emacs/);
    assert.equal(settings.files.editorKeybindingPreset, "jetbrains");
  });

  it("switches one notification, leaves the others alone, and refuses an unknown one", async () => {
    const on = await tetCtl(["settings-set-notification", "idleReminder", "on"]);
    assert.deepEqual(on.result, { saved: true });
    const off = await tetCtl(["settings-set-notification", "finished", "off"]);
    assert.equal(off.status, EXIT_CODES.ok);
    assert.deepEqual(settings.notifications, { finished: false, waiting: true, idleReminder: true });
    const unknown = await tetCtl(["settings-set-notification", "errors", "on"]);
    assert.equal(unknown.status, EXIT_CODES.usage);
    assert.match(unknown.stderr, /unknown notification: errors/);
    const badValue = await tetCtl(["settings-set-notification", "waiting", "yes"]);
    assert.equal(badValue.status, EXIT_CODES.usage);
    assert.equal(settings.notifications.waiting, true);
  });

  it("sets who suggests a commit message and refuses an agent or model that cannot", async () => {
    const set = await tetCtl(["settings-set-commit-suggester", "claude", "sonnet"]);
    assert.deepEqual(set.result, { saved: true });
    assert.deepEqual(settings.prompts.commitSuggester, { agentId: "claude", model: "sonnet" });
    const byDefault = await tetCtl(["settings-set-commit-suggester", "claude"]);
    assert.equal(byDefault.status, EXIT_CODES.ok);
    assert.deepEqual(settings.prompts.commitSuggester, { agentId: "claude", model: "" });
    const model = await tetCtl(["settings-set-commit-suggester", "claude", "gpt"]);
    assert.equal(model.status, EXIT_CODES.usage);
    assert.match(model.stderr, /unknown Claude Code model: gpt \(known: fable, opus, sonnet, haiku\)/);
    const shell = await tetCtl(["settings-set-commit-suggester", "shell"]);
    assert.equal(shell.status, EXIT_CODES.usage);
    assert.match(shell.stderr, /shell cannot suggest a commit message/);
    const unknown = await tetCtl(["settings-set-commit-suggester", "gemini"]);
    assert.equal(unknown.status, EXIT_CODES.usage);
    assert.match(unknown.stderr, /unknown agent: gemini/);
    assert.deepEqual(settings.prompts.commitSuggester, { agentId: "claude", model: "" });
  });

  it("acts on the caller's own repository or worktree when none is given", async () => {
    const run = await tetCtl(["tabs-list"]);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.deepEqual(calls.inspected, [PROJECT.id]);
    await tetCtl(["tabs-list"], { [CONTROL_ENV.worktree]: WORKTREE.worktree });
    assert.deepEqual(calls.inspected, [PROJECT.id, refKeyOf(WORKTREE)], "a worktree tab's is its worktree");
  });

  it("finds a worktree TET made by its branch or key, never one made elsewhere", async () => {
    const head = async (args: string[]): Promise<string> => ((await tetCtl(["repository-state", ...args])).result as { head: string }).head;
    assert.equal(await head(["--worktree", "four"]), `main-of-${refKeyOf(WORKTREE)}`);
    assert.equal(await head(["--worktree", "k4"]), `main-of-${refKeyOf(WORKTREE)}`);
    assert.equal(await head(["--project", PROJECT.id]), "main-of-p1", "--project alone is the repository");
    assert.equal(await head([]), "main-of-p1");
    const madeElsewhere = await tetCtl(["repository-state", "--worktree", "five"]);
    assert.equal(madeElsewhere.status, EXIT_CODES.usage);
    assert.match(madeElsewhere.stderr, /made elsewhere/);
    assert.match((await tetCtl(["repository-state", "--worktree", "nope"])).stderr, /has no worktree nope/);
  });

  it("takes a worktree tab's ids only with its own token", async () => {
    const mainToken = tabControlToken(TOKEN, { projectId: PROJECT.id }, OWN_TAB, HOST_SIDE);
    const run = await tetCtl(["tabs-list"], { [CONTROL_ENV.token]: mainToken, [CONTROL_ENV.worktree]: WORKTREE.worktree });
    assertRefused(run, /not a terminal of this TET/, "the repository's token for a worktree's tab");
  });

  it("lets a host tab reach its repository and every worktree, a sandboxed one only its own", async () => {
    const fromWorktree = { [CONTROL_ENV.worktree]: WORKTREE.worktree };
    assert.equal((await tetCtl(["tabs-output", "tab-2", "--project", PROJECT.id], fromWorktree)).status, EXIT_CODES.ok, "its project's main");
    const sandboxed = { ...fromWorktree, [CONTROL_ENV.tabId]: SANDBOX_TAB };
    assertRefused(await tetCtl(["repository-state", "--project", PROJECT.id], sandboxed), /own repository or worktree/, "the repository from a worktree's sandbox");
    assert.equal((await tetCtl(["repository-state"], sandboxed)).status, EXIT_CODES.ok, "its own");
  });

  it("answers the repository's state for the caller's project, or the one given", async () => {
    assert.equal(((await tetCtl(["repository-state"])).result as { head: string }).head, "main-of-p1");
    assert.equal(((await tetCtl(["repository-state", "--project", OTHER.id])).result as { head: string }).head, "main-of-p2");
  });

  it("takes --project over the caller's own", async () => {
    await tetCtl(["tabs-list", "--project", OTHER.id]);
    assert.deepEqual(calls.inspected, [OTHER.id]);
  });

  it("refuses an unknown project", async () => {
    const run = await tetCtl(["tabs-list", "--project", "p9"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /Project not found/);
  });

  it("needs a project when the caller has none", async () => {
    const run = await tetCtl(["tabs-list"], { [CONTROL_ENV.projectId]: undefined });
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /pass --project/);
  });

  it("opens a tab and brings it to the front", async () => {
    const run = await tetCtl(["tabs-create", "--agent", "shell"]);
    assert.equal((run.result as TabDescriptor).tabId, "tab-new");
    assert.deepEqual(calls.created, ["shell"]);
    assert.deepEqual(calls.shown, [[PROJECT.id, "tab-new"]]);
  });

  it("refuses an agent it does not know", async () => {
    const run = await tetCtl(["tabs-create", "--agent", "gpt"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.deepEqual(calls.created, []);
  });

  it("opens an agent's tab starting on a prompt, and refuses one to a shell or an empty one", async () => {
    assert.equal((await tetCtl(["tabs-create", "--agent", "claude", "--prompt", "fix the build"])).status, EXIT_CODES.ok);
    assert.deepEqual(calls.created, ['claude starting on "fix the build"']);
    const shell = await tetCtl(["tabs-create", "--agent", "shell", "--prompt", "ls"]);
    assert.equal(shell.status, EXIT_CODES.usage);
    assert.match(shell.stderr, /takes no prompt/);
    assert.equal((await tetCtl(["tabs-create", "--agent", "claude", "--prompt", " "])).status, EXIT_CODES.usage, "an empty one");
    assert.equal(calls.created.length, 1);
  });

  it("hands a tab's session to another agent and brings the new tab to the front", async () => {
    assert.deepEqual((await tetCtl(["tabs-hand-over", "tab-2", "--agent", "claude"])).result, tab("tab-handover"));
    assert.deepEqual(calls.handedOff, [["tab-2", "claude", false]]);
    assert.deepEqual(calls.shown, [[PROJECT.id, "tab-handover"]]);
  });

  it("says why a session cannot be handed over, and refuses an agent it does not know", async () => {
    const fresh = await tetCtl(["tabs-hand-over", OWN_TAB, "--agent", "claude"]);
    assert.equal(fresh.status, EXIT_CODES.internal);
    assert.match(fresh.stderr, /no session yet/);
    assert.equal((await tetCtl(["tabs-hand-over", "tab-2", "--agent", "gpt"])).status, EXIT_CODES.usage);
    assert.equal((await tetCtl(["tabs-hand-over", "tab-2"])).status, EXIT_CODES.usage, "no agent");
    assert.deepEqual(calls.shown, []);
  });

  it("runs a saved command by name, and by its command line", async () => {
    assert.equal(((await tetCtl(["tabs-run-command", "build"])).result as TabDescriptor).tabId, "tab-cmd");
    assert.equal((await tetCtl(["tabs-run-command", "npm run build"])).status, EXIT_CODES.ok);
    assert.deepEqual(calls.commands, ["npm run build", "npm run build"]);
    assert.equal(calls.shown.length, 2);
  });

  it("reports a saved command that cannot run, and one that does not exist", async () => {
    assert.equal((await tetCtl(["tabs-run-command", "a && b"])).status, EXIT_CODES.usage);
    const missing = await tetCtl(["tabs-run-command", "deploy"]);
    assert.equal(missing.status, EXIT_CODES.usage);
    assert.match(missing.stderr, /no saved command named deploy/);
  });

  it("closes another tab at once", async () => {
    const run = await tetCtl(["tabs-close", "tab-2"]);
    assert.deepEqual(run.result, { closed: "tab-2" });
    assert.deepEqual(calls.closed, ["tab-2"]);
  });

  it("answers before closing the caller's own tab", async () => {
    const run = await tetCtl(["tabs-close", OWN_TAB]);
    assert.deepEqual(run.result, { closed: OWN_TAB });
    await eventually("what the answer was followed by", () => calls.closed.includes(OWN_TAB));
  });

  it("refuses to close a tab it does not know", async () => {
    assert.equal((await tetCtl(["tabs-close", "tab-9"])).status, EXIT_CODES.usage);
    assert.deepEqual(calls.closed, []);
  });

  it("renames a tab", async () => {
    assert.deepEqual((await tetCtl(["tabs-rename", "tab-2", "Build log"])).result, { renamed: "tab-2" });
    assert.deepEqual(calls.renamed, [["tab-2", "Build log"]]);
  });

  it("fails rather than reporting a rename the agent refused", async () => {
    refuseRename = "Could not rename Claude Code session: no such session";
    const answer = await tetCtl(["tabs-rename", "tab-2", "Build log"]);
    assert.equal(answer.status, EXIT_CODES.internal);
    assert.match(answer.stderr, /no such session/);
  });

  it("refuses to rename a tab it does not know", async () => {
    assert.equal((await tetCtl(["tabs-rename", "tab-9", "Build log"])).status, EXIT_CODES.usage);
    assert.deepEqual(calls.renamed, []);
  });

  it("lists what only the session manager knows of a tab", async () => {
    const [, second] = (await tetCtl(["tabs-list"])).result as { reportedSessionId?: string; sandbox?: string }[];
    assert.deepEqual([second.reportedSessionId, second.sandbox], ["reported-2", "tet-claude-abc"]);
  });

  it("starts and restarts a tab it knows, and refuses one it does not", async () => {
    assert.deepEqual((await tetCtl(["tabs-start", "tab-2"])).result, { started: "tab-2" });
    assert.deepEqual((await tetCtl(["tabs-restart", "tab-2"])).result, { restarted: "tab-2" });
    assert.equal((await tetCtl(["tabs-start", "tab-9"])).status, EXIT_CODES.usage);
    assert.deepEqual([calls.started, calls.restarted], [["tab-2"], ["tab-2"]]);
  });

  it("refuses to start or restart a tab with nothing to do", async () => {
    const started = await tetCtl(["tabs-start", OWN_TAB]);
    assert.equal(started.status, EXIT_CODES.usage);
    assert.match(started.stderr, /not waiting for its first start/);
    const restarted = await tetCtl(["tabs-restart", OWN_TAB]);
    assert.equal(restarted.status, EXIT_CODES.usage);
    assert.match(restarted.stderr, /nothing to restart/);
  });

  it("waits until a tab has what was asked for", async () => {
    setTimeout(() => (tab2Session = "s-2"), 300);
    const run = await tetCtl(["tabs-wait", "tab-2", "--session", "--status", "running"]);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.equal((run.result as TabDescriptor).sessionId, "s-2");
  });

  it("gives up waiting after the timeout, saying what is missing", async () => {
    const run = await tetCtl(["tabs-wait", "tab-2", "--session", "--timeout", "1"]);
    assert.equal(run.status, EXIT_CODES.timeout);
    assert.match(run.stderr, /tab-2 is still not bound to a session/);
  });

  it("stops waiting once the CLI is gone", async () => {
    const body = JSON.stringify({ token: TOKEN, verb: "tabs-wait", args: { tabId: "tab-2", session: true, timeout: 3600, project: PROJECT.id }, caller: {} });
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } });
    req.on("error", () => undefined);
    req.end(body);
    await eventually("the wait polling", () => calls.inspected.length > 2, 5000);
    // What Ctrl+C on the CLI leaves the server: a closed connection.
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const polled = calls.inspected.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(calls.inspected.length, polled, "no polling for a caller that is gone");
  });

  it("refuses to wait for nothing", async () => {
    assert.equal((await tetCtl(["tabs-wait", "tab-2"])).status, EXIT_CODES.usage);
  });

  it("refuses to wait for a status there is none of", async () => {
    assert.equal((await tetCtl(["tabs-wait", "tab-2", "--status", "runing"])).status, EXIT_CODES.usage);
  });

  it("presses keys in a tab, one write each", async () => {
    assert.deepEqual((await tetCtl(["tabs-keys", "tab-2", "down", "enter"])).result, { pressed: "tab-2" });
    assert.deepEqual(calls.written, [
      ["tab-2", "\x1b[B"],
      ["tab-2", "\r"]
    ]);
  });

  it("presses no key it does not know, and types no text", async () => {
    assert.equal((await tetCtl(["tabs-keys", "tab-2"])).status, EXIT_CODES.usage, "no key");
    const text = await tetCtl(["tabs-keys", "tab-2", "enter", "hello"]);
    assert.equal(text.status, EXIT_CODES.usage);
    assert.match(text.stderr, /unknown key: hello/);
    assert.deepEqual(calls.written, [], "not even the keys before it");
  });

  it("presses keys in no tab of another project, nor from outside a project", async () => {
    assertRefused(await tetCtl(["tabs-keys", OWN_TAB, "enter", "--project", OTHER.id]), /own project/, "another project");
    const outside = await tetCtl(["tabs-keys", "tab-2", "enter", "--project", PROJECT.id], { [CONTROL_ENV.projectId]: undefined });
    assertRefused(outside, /own project/, "no project of its own");
    assert.deepEqual(calls.written, []);
  });

  it("types text into a tab as one write, without Enter", async () => {
    assert.deepEqual((await tetCtl(["tabs-text", "tab-2", "fix the build\nthen test"])).result, { typed: "tab-2" });
    assert.deepEqual(calls.written, [["tab-2", "fix the build\nthen test"]]);
    assert.equal((await tetCtl(["tabs-text", "tab-2"])).status, EXIT_CODES.usage, "no text");
  });

  it("types text into no tab of another project, nor from outside a project", async () => {
    assertRefused(await tetCtl(["tabs-text", OWN_TAB, "hello", "--project", OTHER.id]), /own project/, "another project");
    const outside = await tetCtl(["tabs-text", "tab-2", "hello", "--project", PROJECT.id], { [CONTROL_ENV.projectId]: undefined });
    assertRefused(outside, /own project/, "no project of its own");
    assert.deepEqual(calls.written, []);
  });

  it("answers what a tab's terminal shows, its last n KB", async () => {
    assert.deepEqual((await tetCtl(["tabs-output", "tab-2"])).result, { output: "bold line\nnext" });
    const last = (await tetCtl(["tabs-output", OWN_TAB, "--kb", "1"])).result as { output: string };
    assert.equal(last.output.length, 1024);
    assert.ok(last.output.endsWith("end"));
    assert.equal((await tetCtl(["tabs-output", "tab-2", "--kb", "x"])).status, EXIT_CODES.usage);
    assert.equal((await tetCtl(["tabs-output", "tab-2", "--kb", "0"])).status, EXIT_CODES.usage);
  });

  it("fails a tab's output the window does not answer", async () => {
    const run = await tetCtl(["tabs-output", "tab-2", "--worktree", "four"]);
    assert.equal(run.status, EXIT_CODES.internal);
    assert.match(run.stderr, /window did not answer/);
  });

  it("reads no tab of another project, nor from outside a project", async () => {
    assertRefused(await tetCtl(["tabs-output", OWN_TAB, "--project", OTHER.id]), /own project/, "another project");
    const outside = await tetCtl(["tabs-output", "tab-2", "--project", PROJECT.id], { [CONTROL_ENV.projectId]: undefined });
    assertRefused(outside, /own project/, "no project of its own");
    assert.equal((await tetCtl(["tabs-output", OWN_TAB, "--project", PROJECT.id])).status, EXIT_CODES.ok, "its own, named");
  });

  it("refuses a sandboxed tab every verb that acts on this machine", async () => {
    const fromSandbox = { [CONTROL_ENV.tabId]: SANDBOX_TAB };
    const refused = [
      ["tabs-run-command", "build"],
      ["projects-add", workDir],
      ["projects-remove", OTHER.id],
      ["settings-set-theme", "dark-modern"],
      ["settings-set-prompt", "commitMessage", "x"],
      ["settings-set-keybindings", "jetbrains"],
      ["settings-set-notification", "finished", "off"],
      ["settings-set-commit-suggester", "claude"],
      ["app-restart", "--confirm"],
      ["env-request", "GITLAB_TOKEN"],
      ["env-list"],
      ["env-remove", "GITLAB_TOKEN"],
      ["sbx-accounts"],
      ["sbx-sign-in", "work"],
      ["sbx-set-enabled", "off"],
      ["sbx-set-hosts", "example.com"]
    ];
    for (const args of refused) {
      assertRefused(await tetCtl(args, fromSandbox), /inside a sandbox/, args[0]);
    }
    const shell = await tetCtl(["tabs-create", "--agent", "shell"], fromSandbox);
    assert.equal(shell.status, EXIT_CODES.unauthorized, "a shell tab runs on this machine");
    assert.deepEqual(
      [calls.commands, calls.added, calls.removed, calls.started, calls.restarted, calls.written, calls.shutdown, calls.created],
      [[], [], [], [], [], [], [], []]
    );
    assert.equal(settings.appearance.darkTheme, "dark-modern");
    assert.equal(settings.prompts.texts.commitMessage, "");
    assert.deepEqual(calls.sbxSaved, []);
    assert.deepEqual(calls.sbxSignedIn, []);
  });

  it("signs sbx in with a kept access token only, and says who is signed in", async () => {
    sbxStatus = { ...sbxStatus, signedIn: false };
    assert.deepEqual((await tetCtl(["sbx-accounts"])).result, { signedIn: false, accounts: ["skale", "work"] });
    assert.equal((await tetCtl(["sbx-sign-in", "stranger"])).status, EXIT_CODES.usage, "no token kept for that user");
    sbxRefusal = "auth login failed: docker access-token request failed with status 400";
    assert.match((await tetCtl(["sbx-sign-in", "work"])).stderr, /status 400/);
    assert.deepEqual(calls.sbxSignedIn, []);
    sbxRefusal = undefined;
    assert.deepEqual((await tetCtl(["sbx-sign-in", "work"])).result, { signedIn: true, account: "work" });
    assert.deepEqual(calls.sbxSignedIn, ["work"]);
    assert.deepEqual((await tetCtl(["sbx-accounts"])).result, { signedIn: true, account: "work", accounts: ["skale", "work"] });
    sbxNotKept = "no keyring";
    assert.deepEqual((await tetCtl(["sbx-sign-in", "skale"])).result, { signedIn: true, account: "skale", notKept: "no keyring" });
  });

  it("changes one SBX setting and saves the rest as it stands, a stored value kept with its name", async () => {
    const hosts = await tetCtl(["sbx-set-hosts", "example.com", "*.example.org:8080"]);
    assert.deepEqual(hosts.result, { saved: true, restartRequired: false }, "a host applies at once");
    const [[projectId, request, local]] = calls.sbxSaved;
    assert.equal(projectId, PROJECT.id);
    assert.deepEqual(request, { ...EMPTY_SBX_SETTINGS, enabled: true, secrets: [{ env: "API_KEY", hosts: ["api.example.com"] }], hosts: ["example.com", "*.example.org:8080"] });
    assert.deepEqual(local, {
      secrets: { values: {}, from: { API_KEY: "API_KEY" } },
      variables: { values: {}, from: {} },
      knowledge: EMPTY_SBX_KNOWLEDGE
    });
    const folder = path.resolve("/data/one");
    const paths = await tetCtl(["sbx-set-paths", `${folder}:ro`]);
    assert.deepEqual(paths.result, { saved: true, restartRequired: true }, "a mount is added at a tab's start");
    assert.deepEqual(sbxSettings.paths, [{ path: folder, access: "ro" }]);
    assert.equal((await tetCtl(["sbx-set-ports", "8080:80"])).status, EXIT_CODES.ok);
    assert.deepEqual(sbxSettings.ports, [{ host: "8080", container: "80" }]);
    assert.equal((await tetCtl(["sbx-set-variables", "DB_URL"])).status, EXIT_CODES.ok);
    assert.deepEqual(sbxSettings.variables, [{ env: "DB_URL" }]);
    assert.deepEqual(calls.sbxSaved.at(-1)?.[2].variables, { values: {}, from: { DB_URL: "DB_URL" } }, "a bare name types no value");
    assert.equal((await tetCtl(["sbx-set-variables", "DB_URL=a=b", "MODE="])).status, EXIT_CODES.ok);
    assert.deepEqual(sbxSettings.variables, [{ env: "DB_URL" }, { env: "MODE" }]);
    assert.deepEqual(
      calls.sbxSaved.at(-1)?.[2].variables,
      { values: { DB_URL: "a=b" }, from: { DB_URL: "DB_URL", MODE: "MODE" } },
      "NAME=value types a value, split at the first =, an empty one none"
    );
    assert.equal((await tetCtl(["sbx-set-knowledge", "skills", "ro"])).status, EXIT_CODES.ok);
    assert.equal((await tetCtl(["sbx-set-skills-folder", folder])).status, EXIT_CODES.ok);
    assert.deepEqual(sbxKnowledge, { ...EMPTY_SBX_KNOWLEDGE, skills: "ro", skillsFolder: folder });
    assert.equal((await tetCtl(["sbx-set-skills-folder"])).status, EXIT_CODES.ok, "no path: each agent's own");
    assert.deepEqual(sbxKnowledge, { ...EMPTY_SBX_KNOWLEDGE, skills: "ro" });
    assert.equal((await tetCtl(["sbx-set-hosts"])).status, EXIT_CODES.ok, "none clears them");
    assert.deepEqual(sbxSettings.hosts, []);
    assert.deepEqual((await tetCtl(["sbx-get"])).result, {
      status: sbxStatus,
      settings: sbxSettings,
      stored: { secrets: ["API_KEY"], variables: [], knowledge: sbxKnowledge },
      problems: {}
    });
  });

  it("refuses an SBX setting the dialog would not save", async () => {
    const refused = [
      ["sbx-set-ports", "8080"],
      ["sbx-set-ports", "8080:0"],
      ["sbx-set-paths", "relative:ro"],
      ["sbx-set-paths", `${path.resolve("/data")}:x`],
      ["sbx-set-secrets", "TOKEN=https://example.com"],
      ["sbx-set-secrets", "TOKEN="],
      ["sbx-set-variables", "PATH"],
      ["sbx-set-variables", "1X"],
      ["sbx-set-variables", "API_KEY"],
      ["sbx-set-knowledge", "memory", "ro"],
      ["sbx-set-enabled", "maybe"]
    ];
    for (const args of refused) {
      assert.equal((await tetCtl(args)).status, EXIT_CODES.usage, args.join(" "));
    }
    sbxStatus = { installed: true, signedIn: false, policyInitialized: false, blockers: [] };
    assert.match((await tetCtl(["sbx-set-enabled", "on"])).stderr, /not signed in/);
    assert.deepEqual(calls.sbxSaved, []);
  });

  it("saves what can be applied and answers what was left out, as sbx-get does", async () => {
    sbxProblems = { hosts: { "closed.example.com": "Forbidden by governance" } };
    const saved = await tetCtl(["sbx-set-hosts", "open.example.com", "closed.example.com"]);
    assert.deepEqual(saved.result, { saved: true, restartRequired: false, notApplied: sbxProblems });
    assert.deepEqual(sbxSettings.hosts, ["open.example.com"]);
    assert.deepEqual((await tetCtl(["sbx-get"])).result, {
      status: sbxStatus,
      settings: sbxSettings,
      stored: { secrets: ["API_KEY"], variables: [], knowledge: sbxKnowledge },
      problems: sbxProblems
    });
  });

  it("changes nothing but the switch while SBX is disabled", async () => {
    sbxSettings = EMPTY_SBX_SETTINGS;
    assert.match((await tetCtl(["sbx-set-hosts", "example.com"])).stderr, /sbx-set-enabled on first/);
    assert.deepEqual((await tetCtl(["sbx-set-enabled", "on"])).result, { saved: true, restartRequired: false });
    assert.equal(sbxSettings.enabled, true);
  });

  it("changes no SBX Settings of a worktree, which takes its project's", async () => {
    for (const args of [["sbx-set-enabled", "on"], ["sbx-set-hosts", "example.com"]]) {
      const run = await tetCtl([...args, "--worktree", "four"]);
      assert.equal(run.status, EXIT_CODES.usage, args[0]);
      assert.match(run.stderr, /takes its SBX Settings from its project one/, args[0]);
    }
    assert.equal(calls.sbxSaved.length, 0);
  });

  it("answers a sandboxed tab for its own project only", async () => {
    const fromSandbox = { [CONTROL_ENV.tabId]: SANDBOX_TAB };
    // editor-state: its own test below, since a sandbox reads only a file inside the repository.
    assertRefused(await tetCtl(["editor-state", "--project", OTHER.id], fromSandbox), /own repository or worktree/, "editor-state");
    for (const args of [["tabs-list"], ["tabs-close", "tab-2"]]) {
      assertRefused(await tetCtl([...args, "--project", OTHER.id], fromSandbox), /own project/, args[0]);
      assert.equal((await tetCtl(args, fromSandbox)).status, EXIT_CODES.ok, `${args[0]} in its own`);
    }
    for (const args of [["repository-state"], ["explorer-list"], ["sbx-get"], ["sbx-set-variables", "MODE=1"]]) {
      assertRefused(await tetCtl([...args, "--project", OTHER.id], fromSandbox), /own repository or worktree/, args[0]);
      assert.equal((await tetCtl(args, fromSandbox)).status, EXIT_CODES.ok, `${args[0]} in its own`);
    }
    assert.deepEqual(
      (await tetCtl(["projects-list"], fromSandbox)).result,
      [{ ...PROJECT, worktrees: PROJECT.worktrees.filter((worktree) => worktree.key !== undefined) }],
      "its project, with the worktrees TET made"
    );
    assert.deepEqual((await tetCtl(["tabs-create", "--agent", "claude"], fromSandbox)).result, tab("tab-new"));
    assert.deepEqual(calls.created, ["claude (sandbox only)"]);
    assert.equal((await tetCtl(["version"], fromSandbox)).status, EXIT_CODES.ok);
    assert.equal((await tetCtl(["notices-list"], fromSandbox)).status, EXIT_CODES.ok);
    assert.equal((await tetCtl(["hook", "stop"], fromSandbox)).status, EXIT_CODES.ok);
  });

  it("closes, renames and reads from a sandbox only a tab running there", async () => {
    const fromSandbox = { [CONTROL_ENV.tabId]: SANDBOX_TAB };
    for (const args of [
      ["tabs-close", OWN_TAB],
      ["tabs-rename", OWN_TAB, "x"],
      ["tabs-output", OWN_TAB],
      ["tabs-hand-over", OWN_TAB, "--agent", "claude"]
    ]) {
      const run = await tetCtl(args, fromSandbox);
      assert.equal(run.status, EXIT_CODES.usage, args[0]);
      assert.match(run.stderr, /runs on this machine/, args[0]);
    }
    assert.equal((await tetCtl(["tabs-rename", "tab-2", "x"], fromSandbox)).status, EXIT_CODES.ok, "tab-2 runs in the sandbox");
    assert.deepEqual((await tetCtl(["tabs-output", "tab-2"], fromSandbox)).result, { output: "bold line\nnext" });
    assert.equal((await tetCtl(["tabs-hand-over", "tab-2", "--agent", "claude"], fromSandbox)).status, EXIT_CODES.ok);
    assert.deepEqual(calls.handedOff, [["tab-2", "claude", true]], "held to the sandbox");
  });

  it("starts, restarts, presses keys and types in and waits on a sandboxed tab of its project, never a host tab", async () => {
    const fromSandbox = { [CONTROL_ENV.tabId]: SANDBOX_TAB };
    for (const args of [["tabs-start", OWN_TAB], ["tabs-restart", OWN_TAB], ["tabs-keys", OWN_TAB, "enter"], ["tabs-text", OWN_TAB, "hello"], ["tabs-wait", OWN_TAB, "--stopped"]]) {
      const run = await tetCtl(args, fromSandbox);
      assert.equal(run.status, EXIT_CODES.usage, args[0]);
      assert.match(run.stderr, /runs on this machine/, args[0]);
    }
    assert.deepEqual([calls.started, calls.restarted, calls.written], [[], [], []], "nothing done to a host tab");
    // A worktree's sandboxed tab, from the repository's sandbox.
    const inWorktree = ["--worktree", "four"];
    assert.deepEqual((await tetCtl(["tabs-start", "tab-2", ...inWorktree], fromSandbox)).result, { started: "tab-2" });
    assert.deepEqual((await tetCtl(["tabs-restart", "tab-2", ...inWorktree], fromSandbox)).result, { restarted: "tab-2" });
    assert.equal((await tetCtl(["tabs-keys", "tab-2", "enter", ...inWorktree], fromSandbox)).status, EXIT_CODES.ok);
    assert.equal((await tetCtl(["tabs-text", "tab-2", "hello", ...inWorktree], fromSandbox)).status, EXIT_CODES.ok);
    assert.equal(calls.written.length, 2);
    const listed = (await tetCtl(["tabs-list", ...inWorktree], fromSandbox)).result as TabDescriptor[];
    assert.deepEqual(listed.map((entry) => entry.tabId), ["tab-2"], "no host tab listed");
    assertRefused(await tetCtl(["tabs-start", "tab-2", "--project", OTHER.id], fromSandbox), /own project/, "another project");
  });

  it("creates and deletes a sandboxed tab's worktrees of its own project only", async () => {
    const fromSandbox = { [CONTROL_ENV.tabId]: SANDBOX_TAB };
    assertRefused(await tetCtl(["worktree-add", "x", "--project", OTHER.id], fromSandbox), /own project/, "worktree-add");
    assertRefused(await tetCtl(["worktree-delete", "four", "--project", OTHER.id], fromSandbox), /own project/, "worktree-delete");
    assert.equal((await tetCtl(["worktree-add", "x"], fromSandbox)).status, EXIT_CODES.ok);
    const fromWorktreeSandbox = { ...fromSandbox, [CONTROL_ENV.worktree]: WORKTREE.worktree };
    assert.equal((await tetCtl(["worktree-add", "y", "--project", PROJECT.id], fromWorktreeSandbox)).status, EXIT_CODES.ok, "its project's repository named");
    assert.deepEqual(calls.worktreesAdded, [[PROJECT.id, "x"], [PROJECT.id, "y"]]);
    assert.deepEqual((await tetCtl(["worktree-delete", "four", "--force"], fromSandbox)).result, { deleted: "four" });
  });

  it("answers the latest events, as many as asked for", async () => {
    const run = await tetCtl(["events-tail", "--tail", "2"]);
    assert.deepEqual((run.result as { at: number }[]).map((event) => event.at), [2, 3]);
  });

  it("answers a sandbox only the events of tabs running there", async () => {
    const run = await tetCtl(["events-tail", "--tail", "4"], { [CONTROL_ENV.tabId]: SANDBOX_TAB });
    assert.deepEqual((run.result as { at: number }[]).map((event) => event.at), [1, 2, 3], "no host tab's event");
  });

  it("opens a file in the preview tab, or kept, and answers what the active tab shows", async () => {
    assert.deepEqual((await tetCtl(["editor-open", "src/a.ts"])).result, { opened: "src/a.ts", keep: false });
    assert.deepEqual((await tetCtl(["editor-open", "src/b.ts", "--keep"])).result, { opened: "src/b.ts", keep: true });
    assert.deepEqual(calls.editorsOpened, [
      [PROJECT.id, "src/a.ts", false],
      [PROJECT.id, "src/b.ts", true]
    ]);
    assert.deepEqual((await tetCtl(["editor-state"])).result, { ...ACTIVE_EDITOR, content: "edited" });
    assert.equal((await tetCtl(["editor-state", "--project", OTHER.id])).result, null, "no editor tab there");
    assert.deepEqual((await tetCtl(["editor-list"])).result, EDITOR_LISTING);
    assert.deepEqual((await tetCtl(["editor-list", "--project", OTHER.id])).result, []);
  });

  it("shows a sandboxed tab no file reached through a link out of the repository", async (t) => {
    const root = fs.mkdtempSync(path.join(workDir, "repo-"));
    const outside = fs.mkdtempSync(path.join(workDir, "outside-"));
    fs.writeFileSync(path.join(root, "a.txt"), "inside");
    fs.writeFileSync(path.join(outside, "secret.txt"), "host");
    // A junction on win32, where a file symlink needs developer mode; ignored elsewhere.
    fs.symlinkSync(outside, path.join(root, "leak"), "junction");
    const original = { root: PROJECT.path, editor: ACTIVE_EDITOR.path };
    PROJECT.path = root;
    t.after(() => {
      PROJECT.path = original.root;
      ACTIVE_EDITOR.path = original.editor;
    });
    const fromSandbox = { [CONTROL_ENV.tabId]: SANDBOX_TAB };
    assert.equal((await tetCtl(["editor-state"], fromSandbox)).status, EXIT_CODES.ok, "a file inside");
    assert.equal((await tetCtl(["editor-open", "a.txt"], fromSandbox)).status, EXIT_CODES.ok, "opened inside");
    for (const editor of ["leak/secret.txt", "gone.txt"]) {
      ACTIVE_EDITOR.path = editor;
      assertRefused(await tetCtl(["editor-state"], fromSandbox), /missing or leads outside/, editor);
      assertRefused(await tetCtl(["editor-open", editor], fromSandbox), /missing or leads outside/, `open ${editor}`);
      assert.equal((await tetCtl(["editor-state"])).status, EXIT_CODES.ok, `${editor} on this machine`);
    }
  });

  it("opens a file under the path the editor tabs match, and refuses one outside the repository", async () => {
    // PROJECT's root is "", resolved like the working directory.
    for (const typed of ["./src/a.ts", "src\\a.ts", "src/../src/a.ts", path.resolve("src", "a.ts")]) {
      assert.deepEqual((await tetCtl(["editor-open", typed])).result, { opened: "src/a.ts", keep: false }, typed);
    }
    for (const typed of ["../a.ts", path.resolve("..", "a.ts"), "."]) {
      const run = await tetCtl(["editor-open", typed]);
      assert.equal(run.status, EXIT_CODES.usage, typed);
      assert.match(run.stderr, /not inside the repository/, typed);
    }
    assert.equal(calls.editorsOpened.length, 4);
  });

  it("lists the Explorer's files and the notices shown", async () => {
    assert.deepEqual(((await tetCtl(["explorer-list"])).result as { files: string[] }).files, ["p1.txt"]);
    assert.deepEqual((await tetCtl(["notices-list"])).result, [{ severity: "error", message: "Could not delete", at: 1 }]);
  });

  it("refuses too many arguments", async () => {
    assert.equal((await tetCtl(["tabs-rename", "tab-2", "a", "b"])).status, EXIT_CODES.usage);
  });

  // Telling the window is projects.ts's own doing (projects.test.ts), the same for both transports.
  it("adds a project", async () => {
    const run = await tetCtl(["projects-add", workDir]);
    assert.equal((run.result as Project).id, "p3");
    assert.deepEqual(calls.added, [workDir]);
  });

  it("passes on what adding a project had to say", async () => {
    const run = await tetCtl(["projects-add", "/nowhere"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /not a folder/);
  });

  it("removes another project at once", async () => {
    assert.deepEqual((await tetCtl(["projects-remove", OTHER.id])).result, { removed: OTHER.id });
    assert.deepEqual(calls.removed, [OTHER.id]);
  });

  it("removes a project with worktrees only once confirmed", async () => {
    editorListing = [];
    try {
      const refused = await tetCtl(["projects-remove", PROJECT.id], { [CONTROL_ENV.projectId]: OTHER.id });
      assert.equal(refused.status, EXIT_CODES.usage);
      assert.match(refused.stderr, /deletes its 1 worktree with their branches/);
      assert.deepEqual(calls.removed, []);
      assert.deepEqual(
        (await tetCtl(["projects-remove", PROJECT.id, "--confirm"], { [CONTROL_ENV.projectId]: OTHER.id })).result,
        { removed: PROJECT.id }
      );
      assert.deepEqual(calls.removed, [PROJECT.id]);
    } finally {
      editorListing = EDITOR_LISTING;
    }
  });

  it("creates a worktree of the caller's project, named by its new branch", async () => {
    const run = await tetCtl(["worktree-add", "feature/x"]);
    assert.deepEqual(run.result, { projectId: PROJECT.id, worktree: "k5", branch: "feature/x", path: "/wt/feature/x" });
    assert.deepEqual(calls.worktreesAdded, [[PROJECT.id, "feature/x"]]);
    assert.equal((await tetCtl(["worktree-add", "a", "b"])).status, EXIT_CODES.usage, "no start point to name");
  });

  it("passes on what git said when a worktree could not be created", async () => {
    const run = await tetCtl(["worktree-add", "taken"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /already exists/);
  });

  it("deletes a worktree named by its branch, forced only when asked", async () => {
    const refused = await tetCtl(["worktree-delete", "four"]);
    assert.equal(refused.status, EXIT_CODES.usage);
    assert.match(refused.stderr, /uncommitted changes/);
    assert.deepEqual((await tetCtl(["worktree-delete", "four", "--force"])).result, { deleted: "four" });
    assert.deepEqual(calls.worktreesDeleted, [
      [refKeyOf(WORKTREE), false],
      [refKeyOf(WORKTREE), true]
    ]);
  });

  it("deletes only a worktree TET made of the project, and never the caller's own", async () => {
    assert.match((await tetCtl(["worktree-delete", "main"])).stderr, /has no worktree main/);
    assert.match((await tetCtl(["worktree-delete", "four", "--project", OTHER.id])).stderr, /has no worktree four/);
    assert.match((await tetCtl(["worktree-delete", "five"])).stderr, /made elsewhere/);
    const own = await tetCtl(["worktree-delete", "four"], { [CONTROL_ENV.worktree]: WORKTREE.worktree });
    assert.match(own.stderr, /cannot delete itself/);
    assert.deepEqual(calls.worktreesDeleted, []);
  });

  describe("worktree-agent-merge", () => {
    beforeEach(() => {
      merging.deleteRefused = undefined;
    });

    it("merges the base into the worktree, fast-forwards the base in the repository, then deletes the worktree", async () => {
      const run = await tetCtl(["worktree-agent-merge", "four"]);
      assert.equal(run.status, EXIT_CODES.ok, run.stderr);
      assert.deepEqual(run.result, { status: "merged", base: "main", branch: "four" });
      assert.deepEqual(calls.merges, [
        [refKeyOf(WORKTREE), "main", undefined],
        [PROJECT.id, "four", "main"]
      ]);
      assert.deepEqual(calls.worktreesDeleted, [[refKeyOf(WORKTREE), false]]);
      assert.deepEqual(calls.handed, [], "nothing to resolve, nothing handed");
    });

    it("answers a conflict with its files and the worktree as the caller sees it, deleting nothing", async () => {
      merging.merge = "conflict";
      const run = await tetCtl(["worktree-agent-merge", "four"], { [CONTROL_ENV.tabId]: SANDBOX_TAB });
      assert.equal(run.status, EXIT_CODES.ok, run.stderr);
      const result = run.result as { status: string; path: string; files: string[]; next: string };
      assert.equal(result.status, "conflicts");
      assert.equal(result.path, "/sbx/wt/four");
      assert.deepEqual(result.files, ["a.ts"]);
      assert.match(result.next, /git commit[^"]*"tet-ctl worktree-agent-merge four" again/);
      assert.deepEqual(calls.handed, [[SANDBOX_TAB, ["/wt/four"]]]);
      assert.equal(calls.merges.length, 1, "no fast-forward");
      assert.deepEqual(calls.worktreesDeleted, []);
      // Run again while it is still mid-merge.
      const again = await tetCtl(["worktree-agent-merge", "four"]);
      assert.match(again.stderr, /merge is in progress in \/wt\/four: resolve and commit it/);
    });

    it("refuses a caller inside a worktree, saying where to run it from", async () => {
      const run = await tetCtl(["worktree-agent-merge", "four"], { [CONTROL_ENV.worktree]: WORKTREE.worktree });
      assert.equal(run.status, EXIT_CODES.usage);
      assert.match(run.stderr, /only from the project's repository[^.]*close this tab\. Run "tet-ctl worktree-agent-merge four" from a tab of the repository/);
      assert.deepEqual(calls.merges, []);
    });

    it("refuses what it cannot merge, each time saying what to do, and changes nothing", async () => {
      assert.match((await tetCtl(["worktree-agent-merge", "five"])).stderr, /made elsewhere/);
      assert.match((await tetCtl(["worktree-agent-merge", "nine"])).stderr, /has no worktree nine/);
      merging.checkedOut = "develop";
      assert.match((await tetCtl(["worktree-agent-merge", "four"])).stderr, /has develop checked out, not four's base main: run "git switch main" there/);
      merging.checkedOut = "main";
      merging.changes = [{ path: "b.ts", status: "modified" }];
      assert.match((await tetCtl(["worktree-agent-merge", "four"])).stderr, /uncommitted changes, nothing was merged: have them committed or stashed/);
      merging.changes = [];
      tab2Working = true;
      assert.match((await tetCtl(["worktree-agent-merge", "four"])).stderr, /mid-turn \(tab tab-2\), nothing was merged: wait until it is done/);
      tab2Working = false;
      worktreeEditors = EDITOR_LISTING;
      assert.match((await tetCtl(["worktree-agent-merge", "four"])).stderr, /unsaved changes in a\.txt, nothing was merged: ask the user to save/);
      worktreeEditors = [];
      merging.merge = "error";
      assert.match((await tetCtl(["worktree-agent-merge", "four"])).stderr, /unrelated histories — four is unchanged/);
      assert.deepEqual(calls.merges, [[refKeyOf(WORKTREE), "main", undefined]], "only the failed merge ran");
      assert.deepEqual(calls.worktreesDeleted, []);
    });

    it("keeps the base as it is while conflict markers are left, or the fast-forward fails", async () => {
      merging.markers = ["a.ts"];
      assert.match((await tetCtl(["worktree-agent-merge", "four"])).stderr, /conflict markers are left in a\.ts of four, main is unchanged: remove them, commit/);
      merging.markers = [];
      merging.forwardError = "fatal: Not possible to fast-forward, aborting.";
      assert.match((await tetCtl(["worktree-agent-merge", "four"])).stderr, /fast-forward, aborting\. — the merge is committed in four, main is unchanged[^]*run this again/);
      assert.deepEqual(calls.worktreesDeleted, []);
    });

    it("says how to finish when the merged worktree could not be deleted", async () => {
      merging.deleteRefused = { ok: false, needsConfirmation: "uncommitted" };
      const run = await tetCtl(["worktree-agent-merge", "four"]);
      assert.match(run.stderr, /four is merged into main, but its worktree could not be deleted — it has uncommitted changes since[^]*"tet-ctl worktree-delete four" \(--force/);
    });

    it("reaches only the worktrees of a sandboxed caller's own project", async () => {
      const fromSandbox = { [CONTROL_ENV.tabId]: SANDBOX_TAB };
      assertRefused(await tetCtl(["worktree-agent-merge", "four", "--project", OTHER.id], fromSandbox), /own project/, "worktree-agent-merge");
      assert.equal((await tetCtl(["worktree-agent-merge", "four"], fromSandbox)).status, EXIT_CODES.ok);
    });
  });

  it("answers before removing the caller's own project", async () => {
    editorListing = [];
    try {
      assert.deepEqual((await tetCtl(["projects-remove", PROJECT.id, "--confirm"])).result, { removed: PROJECT.id });
      await eventually("what the answer was followed by", () => calls.removed.includes(PROJECT.id));
    } finally {
      editorListing = EDITOR_LISTING;
    }
  });

  it("refuses to remove a project while an editor tab of it has unsaved changes", async () => {
    const run = await tetCtl(["projects-remove", PROJECT.id]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /unsaved changes in a\.txt/);
    assert.deepEqual(calls.removed, []);
  });

  it("relays a notification to the process behind the control channel", async () => {
    assert.deepEqual((await tetCtl(["notify", "Codex: Finished", "Finished in repo"])).result, { notified: true });
    assert.deepEqual(calls.desktopNotifications, [["Codex: Finished", "Finished in repo", { ref: { projectId: PROJECT.id }, tabId: OWN_TAB }]]);
  });

  it("takes a notification that is a title and nothing more", async () => {
    assert.deepEqual((await tetCtl(["notify", "Build finished"])).result, { notified: true });
    assert.deepEqual(calls.desktopNotifications, [["Build finished", "", { ref: { projectId: PROJECT.id }, tabId: OWN_TAB }]]);
  });

  it("is about no tab when the caller is not one", async () => {
    assert.deepEqual((await tetCtl(["notify", "Build finished"], { [CONTROL_ENV.tabId]: undefined })).result, { notified: true });
    assert.deepEqual(calls.desktopNotifications, [["Build finished", "", undefined]], "a click then brings only the window forward");
  });

  it("refuses to restart without --confirm", async () => {
    const run = await tetCtl(["app-restart"]);
    assert.equal(run.status, EXIT_CODES.usage);
    assert.match(run.stderr, /Ask the user/);
    assert.deepEqual(calls.shutdown, []);
  });

  it("answers, then restarts, with --confirm", async () => {
    assert.deepEqual((await tetCtl(["app-restart", "--confirm"])).result, { restarting: true });
    await eventually("what the answer was followed by", () => calls.shutdown.length === 1);
    assert.deepEqual(calls.shutdown, [true]);
  });

  // A prompt-submit hook's stdout is appended to the prompt: TET adds nothing there.
  it("hands a hook's payload over and adds nothing to the prompt", async () => {
    const payload = '{"session_id":"abc","background_tasks":[]}';
    const before = Date.now();
    const run = await tetCtl(["hook", "prompt-submit"], {}, payload);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.equal(run.stdout, "", "TET's system prompt went in once per session");
    assert.deepEqual(calls.hooks, [[OWN_TAB, "prompt-submit", payload]]);
    assert.deepEqual(calls.desktopNotifications, [], "nothing to notify about a prompt");
    // When the hook fired, not when handled: racing reports of one turn are ordered by it, so a
    // finished turn does not go back to working.
    const [at] = calls.hookTimes;
    assert.ok(typeof at === "number" && at >= before && at <= Date.now(), `own time carried through, got ${String(at)}`);
  });

  it("answers a session start with TET's system prompt as added context", async () => {
    const payload = '{"session_id":"abc","source":"startup"}';
    const run = await tetCtl(["hook", "session-start"], {}, payload);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.deepEqual(JSON.parse(run.stdout), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: systemPrompt(HOST_SIDE) }
    });
    assert.deepEqual(calls.hooks, [[OWN_TAB, "session-start", payload]]);
    assert.deepEqual(calls.desktopNotifications, [], "nothing to notify about a session");
  });

  it("tells a sandboxed session start nothing of the environment variables", async () => {
    const run = await tetCtl(["hook", "session-start"], { [CONTROL_ENV.tabId]: SANDBOX_TAB }, "{}");
    assert.equal(run.status, EXIT_CODES.ok);
    const context = (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    assert.equal(context, systemPrompt(SANDBOX_SIDE));
    assert.doesNotMatch(context, /environment variable/);
    assert.match(systemPrompt(HOST_SIDE), /environment variable/);
  });

  it("lists the variables it keeps without values, with those it overrides on this machine, and removes them", async () => {
    envNames = ["GITLAB_TOKEN", "PATH"];
    assert.deepEqual((await tetCtl(["env-list"])).result, [
      { name: "GITLAB_TOKEN", overridesMachine: false },
      { name: "PATH", overridesMachine: true }
    ]);
    assert.deepEqual((await tetCtl(["env-remove", "GITLAB_TOKEN"])).result, { removed: "GITLAB_TOKEN" });
    assert.equal((await tetCtl(["env-remove", "GITLAB_TOKEN"])).status, EXIT_CODES.usage, "gone already");
  });

  it("asks for several variables at once with the caller's tab, and answers what the dialog did", async () => {
    dialogAnswer = ["AUTOCONTRACT_USER", "AUTOCONTRACT_PASSWORD"];
    const saved = await tetCtl(["env-request", "AUTOCONTRACT_USER", "AUTOCONTRACT_PASSWORD", "AUTOCONTRACT_USER"]);
    assert.deepEqual(saved.result, { saved: ["AUTOCONTRACT_USER", "AUTOCONTRACT_PASSWORD"], restartRequired: true });
    assert.deepEqual(calls.envAsks, [
      { ref: { projectId: PROJECT.id }, tabId: OWN_TAB, names: ["AUTOCONTRACT_USER", "AUTOCONTRACT_PASSWORD"] }
    ]);
    dialogAnswer = undefined;
    assert.deepEqual((await tetCtl(["env-request", "GITHUB_TOKEN"])).result, { cancelled: true });
    assert.equal((await tetCtl(["env-request"])).status, EXIT_CODES.usage, "no name");
    assert.equal((await tetCtl(["env-request", "not a name"])).status, EXIT_CODES.usage, "no variable name");
    for (const reserved of ["PATH", "Path", "TET_TAB_ID"]) {
      const refused = await tetCtl(["env-request", reserved]);
      assert.equal(refused.status, EXIT_CODES.usage, reserved);
      assert.match(refused.stderr, /TET's own to set/, reserved);
    }
    // On win32 one variable, as the machine counts them.
    calls.envAsks.length = 0;
    await tetCtl(["env-request", "GITHUB_TOKEN", "github_token"]);
    assert.deepEqual(calls.envAsks[0].names, PLATFORM.envNamesIgnoreCase ? ["GITHUB_TOKEN"] : ["GITHUB_TOKEN", "github_token"]);
  });

  it("takes the environment dialog down once the asking CLI is gone", async () => {
    dialogAnswer = DIALOG_STAYS_OPEN;
    const body = JSON.stringify({ token: TOKEN, verb: "env-request", args: { names: ["GITHUB_TOKEN"] }, caller: {} });
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/", headers: { "Content-Type": "application/json" } });
    req.on("error", () => undefined);
    req.end(body);
    await eventually("the dialog asked", () => calls.envAsks.length === 1, 5000);
    req.destroy();
    await eventually("the dialog withdrawn", () => calls.envWithdrawn.length === 1, 5000);
  });

  it("answers one JSON value where the event has nothing to say, and shows its notification", async () => {
    const run = await tetCtl(["hook", "stop"], {}, "{}");
    assert.equal(run.status, EXIT_CODES.ok);
    assert.equal(run.stdout, "{}", "Codex reads its Stop hook's stdout as JSON");
    assert.deepEqual(
      calls.desktopNotifications,
      [["Claude: Finished", "Finished in one", { ref: { projectId: PROJECT.id }, tabId: OWN_TAB }]],
      "about the tab that reported, which a click on it brings to the front"
    );
  });

  it("reports for the caller's own project, whatever --project names", async () => {
    const run = await tetCtl(["hook", "stop", "--project", OTHER.id], {}, "{}");
    assert.equal(run.status, EXIT_CODES.ok);
    assert.deepEqual(
      calls.desktopNotifications,
      [["Claude: Finished", "Finished in one", { ref: { projectId: PROJECT.id }, tabId: OWN_TAB }]],
      "a tab speaks for itself, never for a tab of another project"
    );
  });

  // A prompt-submit answer is added to the prompt, so a gone tab adds nothing — not even `{}`.
  it("says nothing at all into a prompt it has nothing for", async () => {
    const run = await tetCtl(["hook", "prompt-submit"], { [CONTROL_ENV.tabId]: "tab-gone" });
    assert.equal(run.status, EXIT_CODES.ok);
    assert.equal(run.stdout, "");
    assert.deepEqual(calls.hooks, [["tab-gone", "prompt-submit", ""]]);
  });

  it("carries a payload far bigger than any answer a person would read", async () => {
    // A Stop payload holds the whole last assistant message; 200 KB is a long but ordinary one.
    const payload = JSON.stringify({ session_id: "abc", last_assistant_message: "ü".repeat(200_000) });
    const run = await tetCtl(["hook", "stop"], {}, payload);
    assert.equal(run.status, EXIT_CODES.ok);
    assert.deepEqual(calls.hooks, [[OWN_TAB, "stop", payload]], "whole and unmangled");
  });

  // A non-zero exit or a stray stdout line would land in the turn the hook reports.
  it("says nothing and fails nothing when the event, the tab or TET itself is not there", async () => {
    for (const [what, run] of [
      ["an unknown event", await tetCtl(["hook", "wat"])],
      ["no tab of its own", await tetCtl(["hook", "stop"], { [CONTROL_ENV.tabId]: undefined })],
      ["no TET at all", await tetCtl(["hook", "stop"], { [CONTROL_ENV.port]: undefined })]
    ] as const) {
      assert.equal(run.status, EXIT_CODES.ok, what);
      assert.equal(run.stdout, "", what);
      assert.equal(run.stderr, "", what);
    }
    assert.deepEqual(calls.hooks, [], "none of them reached a tab");
  });

  // The agent's turn waits on its hook, so a stalled TET must not hold it up for good.
  it("gives up on a TET that accepts a hook and never answers", async () => {
    const stalled = http.createServer(() => undefined);
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", () => resolve()));
    try {
      const started = Date.now();
      const run = await tetCtl(["hook", "stop"], { [CONTROL_ENV.port]: String((stalled.address() as { port: number }).port) });
      assert.equal(run.status, EXIT_CODES.ok);
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, "");
      assert.ok(Date.now() - started < 20_000, "ended by its own deadline");
    } finally {
      stalled.closeAllConnections();
      await new Promise((resolve) => stalled.close(resolve));
    }
  });
});

describe("the tet-ctl launcher", () => {
  it("is found on PATH and runs the CLI", async () => {
    const dir = tempDir("tet-launcher-");
    // Here `process.execPath` is node, which ignores ELECTRON_RUN_AS_NODE; the app writes electron.
    const bin = writeLaunchers(dir, CLI);
    const run = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      // cmd.exe resolves a .cmd on PATH and takes the line whole; a POSIX script needs no shell.
      const viaCmd = PLATFORM.cmdLauncher;
      const child = spawn(viaCmd ? "tet-ctl help" : "tet-ctl", viaCmd ? [] : ["help"], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, Path: undefined },
        shell: viaCmd
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.on("close", (status) => resolve({ status, stdout }));
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /tet-ctl — control the TET app/);
  });

  it("leaves nothing set in the cmd.exe that ran it", { skip: !PLATFORM.cmdLauncher }, async () => {
    const dir = tempDir("tet-launcher-");
    const bin = writeLaunchers(dir, CLI);
    const after = await new Promise<string>((resolve) => {
      // One cmd.exe session: the launcher, then a look at the variable.
      const child = spawn(`call tet-ctl help >nul & set ELECTRON_RUN_AS_NODE`, [], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, Path: undefined, ELECTRON_RUN_AS_NODE: undefined },
        shell: true
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.on("close", () => resolve(stdout));
    });
    assert.doesNotMatch(after, /ELECTRON_RUN_AS_NODE=1/);
  });
});
