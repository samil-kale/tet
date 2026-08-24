import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { controlSocketPath } from "../src/main/control-server";
import { CONTROL_ENV } from "../src/shared/control";
import type { Project, RepositoryState, TerminalDescriptor } from "../src/shared/types";
import { eventually, tetCtl } from "./helpers";

/**
 * The real app, driven through tet-ctl alone: started with a profile of its own
 * (`--user-data-dir`, see main.ts) and a token handed in, then asked to open a project, spawn
 * a tab, change a setting and restart. Nothing looks into the window — what the renderer does
 * shows in the main process: a tab it never drew never spawns, and stays "ready".
 *
 * Needs a display (xvfb on a Linux runner) and git, like the app itself.
 */

const ROOT = path.join(__dirname, "..");
const electronPath: string = createRequire(__filename)("electron");
const TOKEN = "app-test-token";
const STARTUP_MS = 60_000;

let userData: string;
let repo: string;
let socketPath: string;
let child: ChildProcess | undefined;
let stderr = "";
/** The instance answering right now — a different process after restart-app. */
let pid: number | undefined;

const env = { [CONTROL_ENV.socket]: "", [CONTROL_ENV.token]: TOKEN };

async function ctl(...args: string[]) {
  return tetCtl(args, env);
}

async function alive(): Promise<number | undefined> {
  const run = await ctl("version");
  return run.status === 0 ? (run.result as { pid: number }).pid : undefined;
}

function kill(target: number): void {
  if (process.platform === "win32") {
    // The whole tree: the app's shell tab is a process of its own under it.
    spawnSync("taskkill", ["/pid", String(target), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(target, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

describe("tet, driven through tet-ctl", { timeout: 4 * STARTUP_MS }, () => {
  before(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "tet-app-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "tet-repo-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    socketPath = controlSocketPath(userData);
    env[CONTROL_ENV.socket] = socketPath;
    child = spawn(electronPath, [ROOT, `--user-data-dir=${userData}`, "--allow-shell-only"], {
      env: { ...process.env, [CONTROL_ENV.token]: TOKEN, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    await eventually(`tet answering on ${socketPath}\n${stderr}`, async () => (pid = await alive()) !== undefined, STARTUP_MS);
  });

  after(async () => {
    // The pid tet reported, or — when it never answered — the electron that was spawned, so a
    // startup that failed leaves no process behind holding the profile directory.
    const target = pid ?? child?.pid;
    if (target !== undefined) {
      kill(target);
    }
    await eventually("tet gone", async () => (await alive()) === undefined, 10_000).catch(() => undefined);
    for (const dir of [userData, repo]) {
      // A pty's conhost can hold a file a moment longer than the app; the OS temp dir is where
      // this is allowed to fail.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("starts with no project and adds the repository", async () => {
    assert.deepEqual((await ctl("projects-list")).result, []);
    const added = await ctl("projects-add", repo);
    assert.equal(added.status, 0, added.stderr);
    const project = added.result as Project;
    assert.equal(project.path, fs.realpathSync(repo));
    assert.deepEqual(((await ctl("projects-list")).result as Project[]).map((entry) => entry.id), [project.id]);
  });

  it("opens a shell tab that actually runs, renames and closes it", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const created = await ctl("tabs-create", "--agent", "shell", "--project", project.id);
    assert.equal(created.status, 0, created.stderr);
    const tab = created.result as TerminalDescriptor;
    const tabs = async (): Promise<TerminalDescriptor[]> =>
      (await ctl("tabs-list", "--project", project.id)).result as TerminalDescriptor[];
    // "running" is the whole chain: terminal:show reached the window, which drew the tab,
    // whose first resize spawned the process. A tab nobody showed stays "ready" forever.
    await eventually(
      "the shell tab running",
      async () => (await tabs()).some((entry) => entry.tabId === tab.tabId && entry.status === "running"),
      STARTUP_MS
    );
    assert.equal((await ctl("tabs-rename", tab.tabId, "Build", "--project", project.id)).status, 0);
    assert.equal((await ctl("tabs-close", tab.tabId, "--project", project.id)).status, 0);
    await eventually("the tab gone", async () => !(await tabs()).some((entry) => entry.tabId === tab.tabId), 10_000);
  });

  it("wrote the shell's output into the context file the agents read", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const contextFile = path.join(userData, "projects", project.id, "context.md");
    await eventually(
      "the shell paragraph",
      () => fs.existsSync(contextFile) && /Shell output from the user's shell tabs/.test(fs.readFileSync(contextFile, "utf8")),
      STARTUP_MS
    );
    assert.match(fs.readFileSync(contextFile, "utf8"), /tet-ctl/);
  });

  it("runs a saved command in a tab that ends the way the command did", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // node is what runs this very test, so it is on the app's PATH too.
    fs.writeFileSync(
      path.join(repo, "tet.json"),
      JSON.stringify({
        commands: [
          { command: "node -e process.exit(3)", name: "fails" },
          { command: "node -e 0", name: "passes" },
          { command: "node -e 0 && node -e 0", name: "chained" }
        ]
      })
    );
    const tabs = async (): Promise<TerminalDescriptor[]> =>
      (await ctl("tabs-list", "--project", project.id)).result as TerminalDescriptor[];
    const statusOf = async (tabId: string): Promise<string | undefined> =>
      (await tabs()).find((entry) => entry.tabId === tabId)?.status;
    const failing = (await ctl("tabs-run-command", "fails", "--project", project.id)).result as TerminalDescriptor;
    assert.equal(failing.savedCommand, true);
    await eventually("the failing command's tab in error", async () => (await statusOf(failing.tabId)) === "error", STARTUP_MS);
    const passing = (await ctl("tabs-run-command", "passes", "--project", project.id)).result as TerminalDescriptor;
    await eventually("the passing command's tab stopped", async () => (await statusOf(passing.tabId)) === "stopped", STARTUP_MS);
    const chained = await ctl("tabs-run-command", "chained", "--project", project.id);
    assert.equal(chained.status, 3, "a shell operator is refused");
    assert.match(chained.stderr, /cannot be run without a shell/);
    assert.equal((await ctl("tabs-run-command", "missing", "--project", project.id)).status, 3);
  });

  it("reflects a commit made in a terminal, as the git pane would", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const state = async (): Promise<RepositoryState> =>
      (await ctl("repo-state", "--project", project.id)).result as RepositoryState;
    await eventually("the first read", async () => (await state()).error === undefined && (await state()).head !== "", STARTUP_MS);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    await eventually(
      "the new file seen",
      async () => (await state()).changes.some((change) => change.path === "README.md" && change.status === "untracked"),
      10_000
    );
    const git = (...args: string[]): void => {
      const result = spawnSync("git", args, {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" }
      });
      assert.equal(result.status, 0, `git ${args.join(" ")}`);
    };
    git("add", "README.md");
    git("commit", "-q", "-m", "first");
    // tet.json from the test before is still untracked; the committed file is what is gone.
    await eventually(
      "the commit seen",
      async () => !(await state()).changes.some((change) => change.path === "README.md"),
      10_000
    );
    assert.equal((await state()).localBranches.length, 1);
  });

  it("changes the theme for the next start only", async () => {
    const set = await ctl("settings-set-theme", "light-modern");
    assert.deepEqual(set.result, { saved: true, restartRequired: true });
    assert.equal(((await ctl("settings-get")).result as { theme: string }).theme, "light-modern");
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).theme, "light-modern");
  });

  it("restarts on --confirm and comes back with the same profile", async () => {
    const before = pid;
    const [project] = (await ctl("projects-list")).result as Project[];
    assert.deepEqual((await ctl("restart-app", "--confirm")).result, { restarting: true });
    await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
    await eventually(
      "the new instance",
      async () => {
        pid = await alive();
        return pid !== undefined && pid !== before;
      },
      STARTUP_MS
    );
    assert.deepEqual(((await ctl("projects-list")).result as Project[]).map((entry) => entry.id), [project.id]);
    assert.equal(((await ctl("settings-get")).result as { theme: string }).theme, "light-modern");
  });

  it("closes a project with a running tab, and forgets it", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // No waiting for the project's terminals: the socket that answered `version` after the
    // restart only exists once the workspace is open (see main.ts's startControl).
    const created = await ctl("tabs-create", "--agent", "shell", "--project", project.id);
    assert.equal(created.status, 0, created.stderr);
    const tab = created.result as TerminalDescriptor;
    await eventually(
      "the tab running",
      async () =>
        ((await ctl("tabs-list", "--project", project.id)).result as TerminalDescriptor[]).some(
          (entry) => entry.tabId === tab.tabId && entry.status === "running"
        ),
      STARTUP_MS
    );
    assert.deepEqual((await ctl("projects-remove", project.id)).result, { removed: project.id });
    assert.deepEqual((await ctl("projects-list")).result, []);
    assert.equal((await ctl("tabs-list", "--project", project.id)).status, 3, "not found");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, "projects.json"), "utf8")), [], "persisted");
  });
});
