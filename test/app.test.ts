import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { resolveRoot } from "../src/main/git/git";
import { UNCAUGHT_MARKER } from "../src/main/uncaught";
import type { AppSettings, Project, RepositoryState, TerminalDescriptor } from "../src/shared/types";
import { eventually, killApp, startApp, tetCtl, type TestApp } from "./helpers";

/**
 * The real app, driven through tet-ctl alone, on a profile of its own (`--user-data-dir`) with a
 * token handed in. Nothing looks into the window — the renderer shows in the main process: a tab
 * it never drew never spawns, and stays "ready".
 *
 * Needs a display (xvfb on a Linux runner) and git.
 */

const TOKEN = "app-test-token";
const STARTUP_MS = 60_000;

let userData: string;
let repo: string;
let app: TestApp | undefined;
/** The instance answering right now — a different process after restart-app. */
let pid: number | undefined;

async function ctl(...args: string[]) {
  assert.ok(app, "tet started");
  return app.ctl(...args);
}

function asTab(projectId: string, tabId: string): Record<string, string | undefined> {
  assert.ok(app, "tet started");
  return app.asTab(projectId, tabId);
}

describe("tet, driven through tet-ctl", { timeout: 4 * STARTUP_MS }, () => {
  before(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "tet-app-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "tet-repo-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    app = await startApp(userData, TOKEN, STARTUP_MS);
    pid = await app.alive();
  });

  after(async () => {
    if (pid !== undefined) {
      killApp(pid);
    }
    await eventually("tet gone", async () => (await app?.alive()) === undefined, 10_000).catch(() => undefined);
    for (const dir of [userData, repo]) {
      // A pty's conhost can hold a file a moment longer than the app; in the temp dir that's fine.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
    // After the cleanup: an unhandled exception fails the run even when every assertion passed —
    // otherwise it shows only as what it broke (e.g. a timeout behind Electron's frozen dialog).
    // Covers the spawned instance only; the one `restart-app` leaves is not on this pipe.
    const stderr = app?.stderr() ?? "";
    const uncaught = stderr.indexOf(UNCAUGHT_MARKER);
    if (uncaught >= 0) {
      assert.fail(`tet reported an uncaught exception:
${stderr.slice(uncaught)}`);
    }
  });

  it("starts with no project and adds the repository", async () => {
    assert.deepEqual((await ctl("projects-list")).result, []);
    const added = await ctl("projects-add", repo);
    assert.equal(added.status, 0, added.stderr);
    const project = added.result as Project;
    // resolveRoot, not realpathSync: addProject stores git's root, which also expands Windows' 8.3
    // short %TEMP% and macOS's /var -> /private/var symlink.
    assert.equal(project.path, await resolveRoot(repo));
    assert.deepEqual(((await ctl("projects-list")).result as Project[]).map((entry) => entry.id), [project.id]);
  });

  it("opens a shell tab that actually runs, renames and closes it", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const created = await ctl("tabs-create", "--agent", "shell", "--project", project.id);
    assert.equal(created.status, 0, created.stderr);
    const tab = created.result as TerminalDescriptor;
    const tabs = async (): Promise<TerminalDescriptor[]> =>
      (await ctl("tabs-list", "--project", project.id)).result as TerminalDescriptor[];
    // "running" is the whole chain: terminal:show reached the window, which drew the tab, whose
    // first resize spawned the process.
    await eventually(
      "the shell tab running",
      async () => (await tabs()).some((entry) => entry.tabId === tab.tabId && entry.status === "running"),
      STARTUP_MS
    );
    assert.equal((await ctl("tabs-rename", tab.tabId, "Build", "--project", project.id)).status, 0);
    assert.equal((await ctl("tabs-close", tab.tabId, "--project", project.id)).status, 0);
    await eventually("the tab gone", async () => !(await tabs()).some((entry) => entry.tabId === tab.tabId), 10_000);
  });

  // An agent's hook end to end: CLI off the tab's environment, control server, session manager,
  // tabs-list. A shell tab stands in for the agent — the verb is about the tab, not its program.
  it("marks a tab's turn from its own hook, and adds nothing to the prompt", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const open = async (): Promise<string> =>
      ((await ctl("tabs-create", "--agent", "shell", "--project", project.id)).result as TerminalDescriptor).tabId;
    const tab = await open();
    // A second tab takes the front: the renderer clears a finished mark on the tab in front.
    const inFront = await open();
    const hook = (event: string): Promise<{ status: number; stdout: string }> =>
      tetCtl(["hook", event], asTab(project.id, tab), "{}");
    const state = async (): Promise<TerminalDescriptor | undefined> =>
      ((await ctl("tabs-list", "--project", project.id)).result as TerminalDescriptor[]).find((entry) => entry.tabId === tab);

    const start = await hook("prompt-submit");
    assert.equal(start.status, 0);
    assert.equal(start.stdout, "", "nothing for the prompt: TET's system prompt went in at spawn");
    await eventually("the tab busy", async () => (await state())?.busy === true, 10_000);

    assert.equal((await hook("stop")).status, 0);
    await eventually("the turn ended", async () => (await state())?.busy === false, 10_000);
    assert.notEqual((await state())?.finishedAt, undefined, "and left the mark that outlives it");
    for (const id of [tab, inFront]) {
      assert.equal((await ctl("tabs-close", id, "--project", project.id)).status, 0);
    }
  });

  it("answers a shell tab's lines", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // A saved command printing a whole line, not a plain shell: whether a shell prints more at
    // startup depends on the machine.
    fs.writeFileSync(
      path.join(repo, "tet.json"),
      JSON.stringify({ commands: [{ command: "node -e \"console.log('tet-context-probe')\"", name: "probe" }] })
    );
    const probe = (await ctl("tabs-run-command", "probe", "--project", project.id)).result as TerminalDescriptor;
    // Read as a tab of that project does: the verb answers only there.
    const lines = async (): Promise<string> =>
      ((await tetCtl(["tabs-shell-output", probe.tabId], asTab(project.id, probe.tabId))).result as
        | { output: string }
        | undefined)?.output ?? "";
    await eventually("the command's line", async () => /tet-context-probe/.test(await lines()), STARTUP_MS);
  });

  it("answers tet-ctl run inside a tab, which holds only its own tab's token", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    fs.writeFileSync(path.join(repo, "tet.json"), JSON.stringify({ commands: [{ command: "tet-ctl tabs-list", name: "list" }] }));
    const list = (await ctl("tabs-run-command", "list", "--project", project.id)).result as TerminalDescriptor;
    const lines = async (): Promise<string> =>
      ((await tetCtl(["tabs-shell-output", list.tabId], asTab(project.id, list.tabId))).result as
        | { output: string }
        | undefined)?.output ?? "";
    // Its own id in the listing: the server took the tab's token for the ids the tab reported.
    await eventually("the tab's own listing", async () => (await lines()).includes(list.tabId), STARTUP_MS);
    assert.doesNotMatch(await lines(), /not a terminal of this TET/);
  });

  it("runs a saved command in a tab that ends the way the command did", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // node is what runs this very test, so it is on the app's PATH too.
    const relative = path.join("bin", process.platform === "win32" ? "tool.exe" : "tool");
    fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
    if (process.platform === "win32") {
      // A native program: node-pty takes it directly, where a relative path once missed the folder.
      fs.copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), path.join(repo, relative));
    } else {
      fs.writeFileSync(path.join(repo, relative), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    fs.writeFileSync(
      path.join(repo, "tet.json"),
      JSON.stringify({
        commands: [
          { command: "node -e process.exit(3)", name: "fails" },
          { command: "node -e 0", name: "passes" },
          { command: "node -e 0 && node -e 0", name: "chained" },
          { command: relative, name: "relative" }
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
    const byPath = (await ctl("tabs-run-command", "relative", "--project", project.id)).result as TerminalDescriptor;
    await eventually("the command by a relative path stopped", async () => (await statusOf(byPath.tabId)) === "stopped", STARTUP_MS);
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
    // Named like git's own locks, which the watcher skips.
    fs.writeFileSync(path.join(repo, "yarn.lock"), "# lockfile\n");
    await eventually(
      "a lockfile seen",
      async () => (await state()).changes.some((change) => change.path === "yarn.lock"),
      10_000
    );
  });

  it("reflects a branch switched in a linked worktree, whose git directory lies outside it", async () => {
    const worktree = `${repo}-worktree`;
    assert.equal(spawnSync("git", ["worktree", "add", "-q", "-b", "in-worktree", worktree], { cwd: repo }).status, 0);
    const added = await ctl("projects-add", worktree);
    assert.equal(added.status, 0, added.stderr);
    const project = added.result as Project;
    const head = async (): Promise<string | undefined> =>
      ((await ctl("repo-state", "--project", project.id)).result as RepositoryState).head;
    try {
      await eventually("the first read", async () => (await head()) === "in-worktree", STARTUP_MS);
      assert.equal(spawnSync("git", ["switch", "-q", "-c", "switched"], { cwd: worktree }).status, 0);
      await eventually("the switch seen", async () => (await head()) === "switched", 10_000);
    } finally {
      await ctl("projects-remove", project.id);
      spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo });
    }
  });

  it("changes a kind's theme without a restart", async () => {
    // The window starts in "system", so dark may not be on screen; either way no restart is needed.
    const set = await ctl("settings-set-theme", "dark-slate");
    assert.deepEqual(set.result, { saved: true, restartRequired: false });
    assert.equal(((await ctl("settings-get")).result as AppSettings).darkTheme, "dark-slate");
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).darkTheme, "dark-slate");
  });

  it("restarts on --confirm and comes back with the same profile", async () => {
    const before = pid;
    const [project] = (await ctl("projects-list")).result as Project[];
    assert.deepEqual((await ctl("restart-app", "--confirm")).result, { restarting: true });
    await new Promise<void>((resolve) => app?.child.once("exit", () => resolve()));
    await eventually(
      "the new instance",
      async () => {
        pid = await app?.alive();
        return pid !== undefined && pid !== before;
      },
      STARTUP_MS
    );
    assert.deepEqual(((await ctl("projects-list")).result as Project[]).map((entry) => entry.id), [project.id]);
    assert.equal(((await ctl("settings-get")).result as AppSettings).darkTheme, "dark-slate");
  });

  it("closes a project with a running tab, and forgets it", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // No wait needed: the control socket exists only once the workspace is open (startControl).
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
