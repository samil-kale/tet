import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { PLATFORM } from "../../src/main/util/host-platform";
import { resolveRoot } from "../../src/main/git/git";
import { UNCAUGHT_MARKER } from "../../src/main/uncaught";
import type { RepositoryState } from "../../src/shared/types/git";
import type { Project } from "../../src/shared/types/project";
import type { AppSettings } from "../../src/shared/types/settings";
import type { TabDescriptor } from "../../src/shared/types/terminals";
import { eventually, killApp, startApp, tempDir, tetCtl, type TestApp } from "../helpers";

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
/** What `userData` links to. */
let profileDir: string;
let repo: string;
let app: TestApp | undefined;
/** The instance answering right now — a different process after app-restart. */
let pid: number | undefined;

function started(): TestApp {
  assert.ok(app, "TET started");
  return app;
}

async function ctl(...args: string[]) {
  return started().ctl(...args);
}

describe("TET, driven through tet-ctl", { timeout: 4 * STARTUP_MS }, () => {
  before(async () => {
    // Through a link, as macOS's /var or a Windows 8.3 %TEMP% reach a folder: a path TET makes under
    // the profile still has to match the on-disk spelling git and the project list use.
    profileDir = tempDir("tet-app-");
    userData = `${profileDir}-link`;
    fs.symlinkSync(profileDir, userData, "junction");
    repo = tempDir("tet-repo-");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    app = await startApp(userData, TOKEN, STARTUP_MS);
    pid = await app.alive();
  });

  after(async () => {
    if (pid !== undefined) {
      killApp(pid);
    }
    await eventually("TET gone", async () => (await app?.alive()) === undefined, 10_000).catch(() => undefined);
    for (const dir of [userData, profileDir, repo]) {
      // A pty's conhost can hold a file a moment longer than the app; in the temp dir that's fine.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
    // After the cleanup: an unhandled exception fails the run even when every assertion passed —
    // otherwise it shows only as what it broke (e.g. a timeout behind Electron's frozen dialog).
    // Covers the spawned instance only; the one `app-restart` leaves is not on this pipe.
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
    assert.deepEqual(
      ((await ctl("projects-list")).result as Project[]).map((entry) => entry.id),
      [project.id],
    );
  });

  it("opens a shell tab that actually runs, renames and closes it", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const created = await ctl("tabs-create", "--agent", "shell", "--project", project.id);
    assert.equal(created.status, 0, created.stderr);
    const tab = created.result as TabDescriptor;
    const tabs = async (): Promise<TabDescriptor[]> => (await ctl("tabs-list", "--project", project.id)).result as TabDescriptor[];
    // "running" is the whole chain: tabs:show reached the window, which drew the tab, whose
    // first resize spawned the process.
    await eventually(
      "the shell tab running",
      async () => (await tabs()).some((entry) => entry.tabId === tab.tabId && entry.status === "running"),
      STARTUP_MS,
    );
    // Only a stopped one: a running session is never ended by an agent's tabs-restart.
    assert.match((await ctl("tabs-restart", tab.tabId, "--project", project.id)).stderr, /has nothing to restart/);
    assert.equal((await ctl("tabs-rename", tab.tabId, "Build", "--project", project.id)).status, 0);
    assert.equal((await ctl("tabs-close", tab.tabId, "--project", project.id)).status, 0);
    await eventually("the tab gone", async () => !(await tabs()).some((entry) => entry.tabId === tab.tabId), 10_000);
  });

  // An agent's hook end to end: CLI off the tab's environment, control server, session manager,
  // tabs-list. A shell tab stands in for the agent — the verb is about the tab, not its program.
  it("marks a tab's turn from its own hook, and adds nothing to the prompt", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const open = async (): Promise<string> =>
      ((await ctl("tabs-create", "--agent", "shell", "--project", project.id)).result as TabDescriptor).tabId;
    const tab = await open();
    // A second tab becomes active: the renderer clears a finished mark on the active tab.
    const activeTab = await open();
    const hook = (event: string): Promise<{ status: number; stdout: string }> =>
      tetCtl(["hook", event], started().asTab(project.id, tab), "{}");
    const state = async (): Promise<TabDescriptor | undefined> =>
      ((await ctl("tabs-list", "--project", project.id)).result as TabDescriptor[]).find((entry) => entry.tabId === tab);

    const start = await hook("prompt-submit");
    assert.equal(start.status, 0);
    assert.equal(start.stdout, "", "nothing for the prompt: TET's system prompt went in at spawn");
    await eventually("the tab working", async () => (await state())?.inTurn === true, 10_000);

    assert.equal((await hook("stop")).status, 0);
    await eventually("the turn ended", async () => (await state())?.inTurn === false, 10_000);
    assert.notEqual((await state())?.finishedAt, undefined, "and left the mark that outlives it");
    for (const id of [tab, activeTab]) {
      assert.equal((await ctl("tabs-close", id, "--project", project.id)).status, 0);
    }
  });

  // The whole way of a browser verb: the tab's page in main, the CDP proxy, Playwright in its own
  // process. Asked as a tab of the project, as an agent asks: the verbs answer only there.
  it("opens a page in a browser tab and acts on it through Playwright", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const shell = (await ctl("tabs-create", "--agent", "shell", "--project", project.id)).result as TabDescriptor;
    const server = http.createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<title>Probe</title><label>Name <input></label>" +
          "<button onclick=\"document.body.append('Saved ' + document.querySelector('input').value)\">Save</button>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const browser = (...args: string[]) => tetCtl(args, started().asTab(project.id, shell.tabId));
      const opened = await browser("browser-open", `127.0.0.1:${(server.address() as AddressInfo).port}`);
      assert.equal(opened.status, 0, opened.stderr);
      assert.equal((opened.result as { title: string }).title, "Probe");
      const { snapshot } = (await browser("browser-snapshot")).result as { snapshot: string };
      const ref = (role: string): string => {
        const found = new RegExp(`${role}[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];
        assert.ok(found, `${role} in ${snapshot}`);
        return found;
      };
      assert.equal((await browser("browser-fill", ref('textbox "Name"'), "Ada")).status, 0);
      assert.equal((await browser("browser-click", ref('button "Save"'))).status, 0);
      const waited = await browser("browser-wait", "--text", "Saved Ada");
      assert.equal(waited.status, 0, waited.stderr);
      const shot = (await browser("browser-screenshot")).result as { path: string };
      assert.equal(fs.readFileSync(shot.path).subarray(1, 4).toString(), "PNG");
      assert.equal((await browser("browser-close")).status, 0);
      assert.deepEqual((await browser("browser-list")).result, []);
    } finally {
      server.close();
      await ctl("tabs-close", shell.tabId, "--project", project.id);
    }
  });

  // The pty's size as its program sees it, the only size tet-ctl can reach: the window's fit is
  // what sets it, so a tab fitted while hidden, or never, shows here as a size of its own.
  it("fits every tab of a pane to the same size, whether shown new, again or for the first time", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // Prints its size at start and on every change, and runs until its tab is closed.
    const probe = path.join(tempDir("tet-size-"), "size.js");
    fs.writeFileSync(
      probe,
      "let last = '';\n" +
        "const report = () => {\n" +
        "  const size = process.stdout.getWindowSize().join('x');\n" +
        "  if (size !== last) { last = size; console.log('tet-size ' + size); }\n" +
        "};\n" +
        "report();\n" +
        "setInterval(report, 50);\n",
    );
    fs.writeFileSync(path.join(repo, "tet.json"), JSON.stringify({ commands: [{ command: `node "${probe}"`, name: "size" }] }));
    const run = async (): Promise<string> =>
      ((await ctl("tabs-run-command", "size", "--project", project.id)).result as TabDescriptor).tabId;
    // Every size the tab's program saw, in order; a repaint repeating a line is not a new size.
    const sizes = async (tabId: string): Promise<string[]> => [
      ...new Set([...(await started().output(project.id, tabId)).matchAll(/tet-size (\d+x\d+)/g)].map((match) => match[1])),
    ];
    const reported = async (tabId: string): Promise<string[]> => {
      await eventually(`tab ${tabId}'s size`, async () => (await sizes(tabId)).length > 0, STARTUP_MS);
      return sizes(tabId);
    };
    const close = async (tabId: string): Promise<void> => {
      assert.equal((await ctl("tabs-close", tabId, "--project", project.id)).status, 0);
    };

    const first = await run();
    const [size] = await reported(first);
    const [cols, rows] = size.split("x").map(Number);
    // Neither unfitted (0, one column) nor tet-ctl's start size for a tab no window fitted.
    assert.ok(cols >= 40 && rows >= 10, `a window's size, not ${size}`);
    assert.notEqual(size, "120x30", "fitted by the window, not started by tet-ctl's default");

    // Shown over the first, which stays as it was while hidden.
    const second = await run();
    assert.deepEqual(await reported(second), [size]);

    // Closing the active tab shows its left neighbour again.
    await close(second);
    // Four at once: the window renders once for several of their shows, so one behind the last may
    // never have been drawn — still "ready", as a process starts on its tab's first fit. The server
    // takes them in any order; its list is the strip's.
    const burst = new Set(await Promise.all([run(), run(), run(), run()]));
    const listed = async (): Promise<TabDescriptor[]> =>
      ((await ctl("tabs-list", "--project", project.id)).result as TabDescriptor[]).filter((entry) => burst.has(entry.tabId));
    const activeTab = (await listed()).at(-1)!.tabId;
    assert.deepEqual(await reported(activeTab), [size]);
    const behind = (await listed()).filter((entry) => entry.tabId !== activeTab);
    const unseen = [...behind].reverse().find((entry) => entry.status === "ready") ?? behind.at(-1)!;
    // Closing a hidden tab shows nothing; closing the active one shows its left neighbour.
    for (const entry of behind.slice(behind.indexOf(unseen) + 1)) {
      await close(entry.tabId);
    }
    await close(activeTab);
    assert.deepEqual(await reported(unseen.tabId), [size], unseen.status === "ready" ? "shown for the first time" : "shown again");

    // By now every fit of the switches above has settled, the debounced one included.
    assert.deepEqual(await sizes(first), [size], "the first tab, hidden and shown again, never refitted");
    for (const tabId of [first, ...behind.slice(0, behind.indexOf(unseen) + 1).map((entry) => entry.tabId)]) {
      await close(tabId);
    }
  });

  it("answers a shell tab's lines", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // A saved command printing a whole line, not a plain shell: whether a shell prints more at
    // startup depends on the machine.
    fs.writeFileSync(
      path.join(repo, "tet.json"),
      JSON.stringify({ commands: [{ command: "node -e \"console.log('tet-context-probe')\"", name: "probe" }] }),
    );
    const probe = (await ctl("tabs-run-command", "probe", "--project", project.id)).result as TabDescriptor;
    const lines = (): Promise<string> => started().output(project.id, probe.tabId);
    await eventually("the command's line", async () => (await lines()).includes("tet-context-probe"), STARTUP_MS);
  });

  it("answers tet-ctl run inside a tab, which holds only its own tab's token", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    fs.writeFileSync(path.join(repo, "tet.json"), JSON.stringify({ commands: [{ command: "tet-ctl tabs-list", name: "list" }] }));
    const list = (await ctl("tabs-run-command", "list", "--project", project.id)).result as TabDescriptor;
    const lines = (): Promise<string> => started().output(project.id, list.tabId);
    // Its own id in the listing: the server took the tab's token for the ids the tab reported.
    await eventually("the tab's own listing", async () => (await lines()).includes(list.tabId), STARTUP_MS);
    assert.doesNotMatch(await lines(), /not a terminal of this TET/);
  });

  it("runs a saved command in a tab that ends the way the command did", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // node is what runs this very test, so it is on the app's PATH too.
    const relative = path.join("bin", PLATFORM.executableByExtension ? "tool.exe" : "tool");
    fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
    if (PLATFORM.executableByExtension) {
      // A native program: node-pty takes it directly.
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
          { command: relative, name: "relative" },
        ],
      }),
    );
    const tabs = async (): Promise<TabDescriptor[]> => (await ctl("tabs-list", "--project", project.id)).result as TabDescriptor[];
    const statusOf = async (tabId: string): Promise<string | undefined> => (await tabs()).find((entry) => entry.tabId === tabId)?.status;
    const failing = (await ctl("tabs-run-command", "fails", "--project", project.id)).result as TabDescriptor;
    assert.equal(failing.savedCommand, true);
    await eventually("the failing command's tab in error", async () => (await statusOf(failing.tabId)) === "error", STARTUP_MS);
    const passing = (await ctl("tabs-run-command", "passes", "--project", project.id)).result as TabDescriptor;
    await eventually("the passing command's tab stopped", async () => (await statusOf(passing.tabId)) === "stopped", STARTUP_MS);
    const byPath = (await ctl("tabs-run-command", "relative", "--project", project.id)).result as TabDescriptor;
    await eventually("the command by a relative path stopped", async () => (await statusOf(byPath.tabId)) === "stopped", STARTUP_MS);
    const chained = await ctl("tabs-run-command", "chained", "--project", project.id);
    assert.equal(chained.status, 3, "a shell operator is refused");
    assert.match(chained.stderr, /cannot be run without a shell/);
    assert.equal((await ctl("tabs-run-command", "missing", "--project", project.id)).status, 3);
  });

  it("reflects a commit made in a terminal, as the git lane would", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    const state = async (): Promise<RepositoryState> => (await ctl("repository-state", "--project", project.id)).result as RepositoryState;
    await eventually("the first read", async () => (await state()).error === undefined && (await state()).head !== "", STARTUP_MS);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    await eventually(
      "the new file seen",
      async () => (await state()).changes.some((change) => change.path === "README.md" && change.status === "untracked"),
      10_000,
    );
    const git = (...args: string[]): void => {
      const result = spawnSync("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t.invalid",
        },
      });
      assert.equal(result.status, 0, `git ${args.join(" ")}`);
    };
    git("add", "README.md");
    git("commit", "-q", "-m", "first");
    // tet.json from the test before is still untracked; the committed file is what is gone.
    await eventually("the commit seen", async () => !(await state()).changes.some((change) => change.path === "README.md"), 10_000);
    assert.equal((await state()).localBranches.length, 1);
    // Named like git's own locks, which the watcher skips.
    fs.writeFileSync(path.join(repo, "yarn.lock"), "# lockfile\n");
    await eventually("a lockfile seen", async () => (await state()).changes.some((change) => change.path === "yarn.lock"), 10_000);
  });

  it("reflects a branch switched in a worktree TET made, whose git directory lies outside it", async () => {
    const [main] = (await ctl("projects-list")).result as Project[];
    const added = await ctl("worktree-add", "in-worktree", "--project", main.id);
    assert.equal(added.status, 0, added.stderr);
    const { worktree, path: files } = added.result as { worktree: string; path: string };
    // By its key: the branch that names it is what changes.
    const head = async (): Promise<string | undefined> =>
      ((await ctl("repository-state", "--project", main.id, "--worktree", worktree)).result as RepositoryState).head;
    try {
      await eventually("the first read", async () => (await head()) === "in-worktree", STARTUP_MS);
      assert.equal(spawnSync("git", ["switch", "-q", "-c", "switched"], { cwd: files }).status, 0);
      await eventually("the switch seen", async () => (await head()) === "switched", 10_000);
      await eventually(
        "the row named by its new branch",
        async () =>
          ((await ctl("projects-list")).result as Project[])
            .find((project) => project.id === main.id)
            ?.worktrees.some((entry) => entry.key === worktree && entry.branch === "switched") === true,
        10_000,
      );
    } finally {
      const deleted = await ctl("worktree-delete", worktree, "--project", main.id, "--force");
      assert.equal(deleted.status, 0, deleted.stderr);
      spawnSync("git", ["branch", "-D", "in-worktree"], { cwd: repo });
    }
  });

  it("lists a worktree made with plain git, but never opens it", async () => {
    const [main] = (await ctl("projects-list")).result as Project[];
    const elsewhere = `${repo}-elsewhere`;
    assert.equal(spawnSync("git", ["worktree", "add", "-q", "-b", "elsewhere", elsewhere], { cwd: repo }).status, 0);
    try {
      await eventually(
        "listed without a key",
        async () =>
          ((await ctl("projects-list")).result as Project[])
            .find((project) => project.id === main.id)
            ?.worktrees.some((entry) => entry.branch === "elsewhere" && entry.key === undefined) === true,
        STARTUP_MS,
      );
      const refused = await ctl("repository-state", "--project", main.id, "--worktree", "elsewhere");
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /made elsewhere/);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", elsewhere], { cwd: repo });
      spawnSync("git", ["branch", "-D", "elsewhere"], { cwd: repo });
    }
  });

  it("creates a worktree under its project's folder in the profile, and deletes it with its branch", async () => {
    const [main] = (await ctl("projects-list")).result as Project[];
    const added = await ctl("worktree-add", "from/ctl", "--project", main.id);
    assert.equal(added.status, 0, added.stderr);
    const worktree = added.result as { projectId: string; worktree: string; branch: string; path: string };
    // Named by its key, which never changes; the branch names only the row.
    assert.equal(worktree.path, path.join(fs.realpathSync.native(userData), "projects", main.id, "worktrees", worktree.worktree));
    assert.equal(worktree.branch, "from/ctl");
    await eventually(
      "the new branch read",
      async () =>
        ((await ctl("repository-state", "--project", main.id, "--worktree", "from/ctl")).result as RepositoryState).head === "from/ctl",
      STARTUP_MS,
    );
    const deleted = await ctl("worktree-delete", "from/ctl", "--project", main.id);
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.ok(!fs.existsSync(worktree.path));
    const listed = ((await ctl("projects-list")).result as Project[]).find((project) => project.id === main.id);
    assert.ok(!listed?.worktrees.some((entry) => entry.key === worktree.worktree));
    const branches = ((await ctl("repository-state", "--project", main.id)).result as RepositoryState).localBranches;
    assert.ok(!branches.includes("from/ctl"), "its branch went with it");
  });

  it("changes a kind's theme without a restart", async () => {
    // The window starts in "system", so dark may not be on screen; either way no restart is needed.
    const set = await ctl("settings-set-theme", "dark-slate");
    assert.deepEqual(set.result, { saved: true, restartRequired: false });
    assert.equal(((await ctl("settings-get")).result as AppSettings).appearance.darkTheme, "dark-slate");
    const settings = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")) as { appearance: { darkTheme: string } };
    assert.equal(settings.appearance.darkTheme, "dark-slate");
  });

  it("restarts on --confirm and comes back with the same profile", async () => {
    const previousPid = pid;
    const [project] = (await ctl("projects-list")).result as Project[];
    assert.deepEqual((await ctl("app-restart", "--confirm")).result, { restarting: true });
    await new Promise<void>((resolve) => app?.child.once("exit", () => resolve()));
    await eventually(
      "the new instance",
      async () => {
        pid = await app?.alive();
        return pid !== undefined && pid !== previousPid;
      },
      STARTUP_MS,
    );
    assert.deepEqual(
      ((await ctl("projects-list")).result as Project[]).map((entry) => entry.id),
      [project.id],
    );
    assert.equal(((await ctl("settings-get")).result as AppSettings).appearance.darkTheme, "dark-slate");
  });

  it("closes a project with a running tab, and forgets it", async () => {
    const [project] = (await ctl("projects-list")).result as Project[];
    // No wait needed: the control socket exists only once the workspace is open (startControl).
    const created = await ctl("tabs-create", "--agent", "shell", "--project", project.id);
    assert.equal(created.status, 0, created.stderr);
    const tab = created.result as TabDescriptor;
    await eventually(
      "the tab running",
      async () =>
        ((await ctl("tabs-list", "--project", project.id)).result as TabDescriptor[]).some(
          (entry) => entry.tabId === tab.tabId && entry.status === "running",
        ),
      STARTUP_MS,
    );
    assert.deepEqual((await ctl("projects-remove", project.id)).result, { removed: project.id });
    assert.deepEqual((await ctl("projects-list")).result, []);
    assert.equal((await ctl("tabs-list", "--project", project.id)).status, 3, "not found");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, "projects.json"), "utf8")), [], "persisted");
  });
});
