import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PLATFORM } from "../../src/main/util/host-platform";
import { machineSets } from "../../src/main/store/env-names";
import { EnvRequests } from "../../src/main/control/env-requests";
import { EnvStore } from "../../src/main/store/environment";
import type { EnvRequest } from "../../src/shared/types/environment";
import { ProjectStore } from "../../src/main/store/project-store";
import { agentConfigDir } from "../../src/main/store/data-root";
import { newWorktreeKey, ownedWorktreeKeys, sandboxDir, sandboxSessionDir, worktreeDir, worktreeKeyOf } from "../../src/main/store/project-dirs";
import { SettingsStore } from "../../src/main/store/settings";
import { DEFAULT_PROMPTS, effectivePrompt } from "../../src/shared/prompts";
import { DEFAULT_KEYBINDING_PRESET_ID, withLanePinned, withSettings } from "../../src/shared/types/settings";
import { tempDir } from "../helpers";

/** store/: the data folder's layout, the stores, the environment variables kept in TET. */

describe("a project's folder under ~/.tet", () => {
  it("lays out a sandbox folder per agent under sandboxes/repository/ or sandboxes/<key>/, the host setup once per agent", () => {
    const root = path.join(os.tmpdir(), "tet-data");
    const repository = { projectId: "p" };
    const worktree = { projectId: "p", worktree: "k1" };
    assert.equal(sandboxDir(root, worktree, "codex"), path.join(root, "projects", "p", "sandboxes", "k1", "codex"));
    assert.equal(sandboxSessionDir(sandboxDir(root, repository, "pi")), path.join(root, "projects", "p", "sandboxes", "repository", "pi", "sessions"));
    assert.equal(agentConfigDir(root, "claude"), path.join(root, "config", "claude"));
  });

  it("knows a worktree TET made by its path, and no other", () => {
    const root = tempDir("tet-data-");
    const files = worktreeDir(root, "p", "k1");
    assert.equal(worktreeKeyOf(root, "p", files), "k1");
    assert.equal(worktreeKeyOf(root, "q", files), undefined, "another project's");
    assert.equal(worktreeKeyOf(root, "p", path.dirname(files)), undefined, "not the worktree's folder itself");
    assert.equal(worktreeKeyOf(root, "p", path.join(os.tmpdir(), "elsewhere")), undefined, "one made elsewhere");
  });

  it("gives a new worktree a key no other of the project has, and lists those with their files", () => {
    const root = tempDir("tet-data-");
    const key = newWorktreeKey(root, "p");
    assert.match(key, /^[0-9a-f]{8}$/);
    fs.mkdirSync(worktreeDir(root, "p", key), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir(root, "p", key), ".git"), "gitdir: x");
    fs.mkdirSync(path.join(root, "projects", "p", "worktrees", "halfway"), { recursive: true });
    assert.deepEqual(ownedWorktreeKeys(root, "p"), [key], "one left without its files is none");
    assert.notEqual(newWorktreeKey(root, "p"), key);
  });
});

describe("the environment variables kept in TET", () => {
  const tempRoot = (): string => tempDir("tet-environment-");
  const row = (name: string, value: string): { name: string; value: string } => ({ name, value });

  it("keep one row per name, hand out their values, and read the file fresh every time", () => {
    const root = tempRoot();
    const store = new EnvStore(root);
    store.set([row("GITLAB_TOKEN", "old")]);
    store.set([row("GITLAB_TOKEN", "new"), row("STRIPE_KEY", "sk")]);
    assert.deepEqual(store.list(), [
      { name: "GITLAB_TOKEN", overridesMachine: false },
      { name: "STRIPE_KEY", overridesMachine: false }
    ]);
    // Its own name: the first one in process.env may be one a TET this runs in kept (TET_KEPT_ENV).
    process.env.TET_TEST_MACHINE = "machine";
    try {
      store.set([row("TET_TEST_MACHINE", "x")]);
      assert.equal(store.info("TET_TEST_MACHINE")?.overridesMachine, true, "one this machine sets too");
    } finally {
      delete process.env.TET_TEST_MACHINE;
    }
    store.remove("TET_TEST_MACHINE");
    assert.deepEqual(store.values(), { GITLAB_TOKEN: "new", STRIPE_KEY: "sk" });
    const other = new EnvStore(root);
    assert.equal(other.remove("STRIPE_KEY"), true);
    assert.equal(other.remove("STRIPE_KEY"), false);
    assert.deepEqual(store.values(), { GITLAB_TOKEN: "new" }, "a change from outside is seen, not overwritten");
  });

  it("take a name in another case for the same variable where the machine does", { skip: !PLATFORM.envNamesIgnoreCase }, () => {
    const store = new EnvStore(tempRoot());
    store.set([row("gitlab_token", "old")]);
    store.set([row("GITLAB_TOKEN", "new")]);
    assert.deepEqual(store.values(), { GITLAB_TOKEN: "new" }, "one variable, not two in every tab");
    assert.equal(store.info("gitlab_token")?.name, "GITLAB_TOKEN");
    assert.equal(store.remove("gitlab_token"), true);
    assert.deepEqual(store.values(), {});
  });

  it("tell the machine's variables from those a TET it was started from set", () => {
    const inherited = process.env.TET_KEPT_ENV;
    process.env.TET_TEST_FROM_OUTER = "outer";
    process.env.TET_TEST_OWN_MACHINE = "machine";
    process.env.TET_KEPT_ENV = "TET_TEST_FROM_OUTER";
    try {
      assert.equal(machineSets("TET_TEST_FROM_OUTER"), false, "an outer TET's, not the machine's");
      assert.equal(machineSets("TET_TEST_OWN_MACHINE"), true);
    } finally {
      delete process.env.TET_TEST_FROM_OUTER;
      delete process.env.TET_TEST_OWN_MACHINE;
      if (inherited === undefined) {
        delete process.env.TET_KEPT_ENV;
      } else {
        process.env.TET_KEPT_ENV = inherited;
      }
    }
  });

  it("write nothing over a file they cannot read, and drop no row they do not understand", () => {
    const root = tempRoot();
    const file = path.join(root, "environment.json");
    fs.writeFileSync(file, '[{"name": "GITLAB_TOKEN", "value": "c2VhbGVkOng="}, ');
    const broken = new EnvStore(root);
    assert.deepEqual(broken.list(), []);
    assert.deepEqual(broken.values(), {});
    assert.throws(() => broken.set([row("GITHUB_TOKEN", "token")]), /environment\.json/);
    assert.throws(() => broken.remove("GITLAB_TOKEN"), /environment\.json/);
    assert.equal(fs.readFileSync(file, "utf8"), '[{"name": "GITLAB_TOKEN", "value": "c2VhbGVkOng="}, ', "left as it was");

    fs.writeFileSync(file, JSON.stringify([{ name: "FUTURE", value: 7 }]));
    const store = new EnvStore(root);
    store.set([row("GITHUB_TOKEN", "token")]);
    assert.deepEqual(
      (JSON.parse(fs.readFileSync(file, "utf8")) as { name: string }[]).map((entry) => entry.name),
      ["FUTURE", "GITHUB_TOKEN"]
    );
    assert.deepEqual(store.list().map((entry) => entry.name), ["GITHUB_TOKEN"], "listed only when understood");
  });

  it("take the Settings' tab whole: added, renamed with its value, replaced, and the rest deleted", () => {
    const store = new EnvStore(tempRoot());
    store.set([row("GITLAB_TOKEN", "gl"), row("STRIPE_KEY", "sk"), row("OLD", "o")]);
    store.edit([
      { name: "GITLAB_API_TOKEN", from: "GITLAB_TOKEN" },
      { name: "STRIPE_KEY", from: "STRIPE_KEY", value: "sk-new" },
      { name: "SENDGRID_API_KEY", value: "sg" }
    ]);
    assert.deepEqual(store.values(), { GITLAB_API_TOKEN: "gl", STRIPE_KEY: "sk-new", SENDGRID_API_KEY: "sg" });
  });

  it("refuse the Settings' tab with a row it cannot take, changing nothing", () => {
    const store = new EnvStore(tempRoot());
    store.set([row("GITLAB_TOKEN", "gl")]);
    const refusals: [{ name: string; from?: string; value?: string }[], RegExp][] = [
      [[{ name: "1TOKEN", value: "x" }], /not an environment variable name/],
      [[{ name: "Path", value: "x" }], /TET's own to set/],
      [[{ name: "NEW" }], /NEW needs a value/],
      [[{ name: "A", value: "x" }, { name: "A", value: "y" }], /A is there twice/]
    ];
    for (const [rows, refusal] of refusals) {
      assert.throws(() => store.edit(rows), refusal);
    }
    assert.deepEqual(store.values(), { GITLAB_TOKEN: "gl" }, "left as it was");
  });

  it("are asked for one request at a time, several names in one, every one needing a value", async () => {
    const store = new EnvStore(tempRoot());
    store.set([row("AUTOCONTRACT_USER", "old")]);
    const shown: EnvRequest[] = [];
    const requests = new EnvRequests(
      store,
      (request) => {
        shown.push(request);
        return true;
      },
      () => undefined
    );
    const alive = new AbortController().signal;
    const first = requests.ask({ names: ["AUTOCONTRACT_USER", "AUTOCONTRACT_PASSWORD"] }, alive);
    const second = requests.ask({ names: ["GITHUB_TOKEN"] }, alive);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shown.length, 1, "the second waits for the first");
    assert.deepEqual(shown[0].variables, [
      { name: "AUTOCONTRACT_USER", overridesMachine: false, stored: true },
      { name: "AUTOCONTRACT_PASSWORD", overridesMachine: false, stored: false }
    ]);
    assert.match(requests.answer(1, [row("AUTOCONTRACT_USER", "admin")]) ?? "", /needs a value/, "one missing");
    assert.equal(
      requests.answer(1, [row("AUTOCONTRACT_USER", "admin"), row("AUTOCONTRACT_PASSWORD", "secret"), row("OTHER", "x")]),
      undefined
    );
    assert.deepEqual(await first, ["AUTOCONTRACT_USER", "AUTOCONTRACT_PASSWORD"]);
    assert.deepEqual(store.values(), { AUTOCONTRACT_USER: "admin", AUTOCONTRACT_PASSWORD: "secret" }, "only what was asked for");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shown.length, 2);
    assert.equal(requests.answer(2, null), undefined);
    assert.equal(await second, undefined);
  });

  it("withdraw a request whose caller left, say a late Save saved nothing, and refuse without a window", async () => {
    const withdrawn: number[] = [];
    let listening = true;
    const requests = new EnvRequests(
      new EnvStore(tempRoot()),
      () => listening,
      (id) => withdrawn.push(id)
    );
    const caller = new AbortController();
    const asked = requests.ask({ names: ["GITHUB_TOKEN"] }, caller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    caller.abort();
    assert.equal(await asked, undefined);
    assert.deepEqual(withdrawn, [1]);
    assert.match(requests.answer(1, [row("GITHUB_TOKEN", "x")]) ?? "", /stopped waiting/);
    assert.equal(requests.answer(1, null), undefined, "a late Cancel needs no words");
    listening = false;
    await assert.rejects(requests.ask({ names: ["GITHUB_TOKEN"] }, new AbortController().signal), /not ready/);
  });
});

describe("the stores", () => {
  it("read a hand-edited settings file field by field", () => {
    const dir = tempDir("tet-settings-");
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{ nope");
    assert.equal(new SettingsStore(dir).get().appearance.colorScheme, "system");
    assert.deepEqual(new SettingsStore(dir).get().appearance.lanes, { pinned: ["projects"], order: ["projects", "git", "files"] });
    fs.writeFileSync(
      file,
      JSON.stringify({
        appearance: { colorScheme: "sepia", darkTheme: "solarized", lanes: { pinned: ["git", "nope", "git"], order: ["files", 3, "files"] } },
        notifications: { finished: false, waiting: "yes" },
        files: { editorKeybindingPreset: "" },
        git: { pushOnCommit: true, checkNewChanges: "yes" },
        prompts: { texts: { commitMessage: DEFAULT_PROMPTS.commitMessage, commands: "removed setting" }, commitSuggester: "claude" }
      })
    );
    const settings = new SettingsStore(dir).get();
    assert.deepEqual(settings.notifications, { finished: false, waiting: true, idleReminder: false });
    assert.deepEqual(settings.git, {
      checkNewChanges: false,
      pushOnCommit: true,
      deleteBranchOnRemote: false,
      deleteTagOnRemote: false,
      deleteWorktreeOnRemote: false
    });
    assert.equal(settings.appearance.colorScheme, "system");
    assert.equal(settings.appearance.darkTheme, "solarized", "an unknown id is left standing for the readers to fall back from");
    assert.equal(settings.appearance.lightTheme, "light-modern");
    assert.deepEqual(
      settings.appearance.lanes,
      { pinned: ["git"], order: ["files", "projects", "git"] },
      "no lane named twice or unknown, the order takes the ones it misses at its end"
    );
    assert.equal(settings.files.editorKeybindingPreset, DEFAULT_KEYBINDING_PRESET_ID);
    assert.deepEqual(settings.prompts.texts, { commitMessage: "", handover: "" }, "TET's own text spelled out is stored as none");
    assert.deepEqual(settings.prompts.commitSuggester, { agentId: "", model: "" });
    assert.equal(effectivePrompt(settings.prompts.texts, "commitMessage"), DEFAULT_PROMPTS.commitMessage);
    assert.equal(effectivePrompt({ commitMessage: "write a subject", handover: "" }, "commitMessage"), "write a subject");
    const store = new SettingsStore(dir);
    store.patch({ appearance: { colorScheme: "light" } });
    assert.equal(new SettingsStore(dir).get().appearance.colorScheme, "light", "written and read back");
  });

  it("say when a Save could not be written, and keep what they had", () => {
    const dir = tempDir("tet-settings-");
    // A folder where the file goes: no platform renames a file over it.
    fs.mkdirSync(path.join(dir, "settings.json"));
    const store = new SettingsStore(dir);
    assert.throws(() => store.patch({ appearance: { colorScheme: "light" } }));
    assert.equal(store.get().appearance.colorScheme, "system", "unchanged, as the disk is");
  });

  it("keep only well-formed projects and reorder what they know", () => {
    const dir = tempDir("tet-projects-");
    const pathOf = (name: string): string => path.resolve(path.sep, name);
    fs.writeFileSync(
      path.join(dir, "projects.json"),
      JSON.stringify([
        { id: "a", path: pathOf("a"), name: "a" },
        { id: "b", path: pathOf("b") },
        "junk",
        { id: "c", path: pathOf("c"), name: "c" }
      ])
    );
    const store = new ProjectStore(dir);
    assert.deepEqual(store.list().map((project) => project.id), ["a", "c"]);
    const added = store.add(path.join(dir, "repo"), "r");
    assert.deepEqual([added.name, added.worktrees], ["repo", []]);
    store.reorder(["nope", added.id]);
    assert.deepEqual(store.list().map((project) => project.id), [added.id, "a", "c"], "unknown dropped, omitted kept behind");
    assert.ok(store.setWorktrees("a", [{ path: pathOf("wt"), branch: "feature" }]));
    assert.equal(store.setWorktrees("a", [{ path: pathOf("wt"), branch: "feature" }]), false, "unchanged");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, "projects.json"), "utf8"))[1],
      { id: "a", path: pathOf("a"), name: "a" },
      "worktrees are read off the disk, never stored"
    );
    assert.equal(new ProjectStore(dir).list().length, 3, "persisted");
    assert.deepEqual(fs.readdirSync(dir), ["projects.json"], "renamed into place, no temporary file left");
  });
});

describe("pinning a lane", () => {
  const lanes = { pinned: ["projects" as const], order: ["projects" as const, "git" as const, "files" as const] };

  it("takes it to the end of the pinned ones, and an unpinned one to the front of the toggles", () => {
    const pinned = withLanePinned(lanes, "files", true);
    assert.deepEqual(pinned, { pinned: ["projects", "files"], order: ["projects", "files", "git"] });
    assert.deepEqual(withLanePinned(pinned, "projects", false), { pinned: ["files"], order: ["files", "projects", "git"] });
  });

  it("leaves a lane already so where it is", () => {
    assert.equal(withLanePinned(lanes, "projects", true), lanes);
    assert.equal(withLanePinned(lanes, "git", false), lanes);
  });
});

describe("a settings write", () => {
  it("changes the keys it names and no others, down to one prompt", () => {
    const stored = {
      appearance: { colorScheme: "light", darkTheme: "dark-modern" },
      prompts: { texts: { a: "", b: "theirs" }, commitSuggester: { agentId: "claude", model: "" } },
      notifications: { finished: false, waiting: true }
    };
    assert.deepEqual(withSettings(stored as never, { appearance: { darkTheme: "dark-slate" }, prompts: { texts: { a: "mine" } as never } }), {
      appearance: { colorScheme: "light", darkTheme: "dark-slate" },
      prompts: { texts: { a: "mine", b: "theirs" }, commitSuggester: { agentId: "claude", model: "" } },
      notifications: { finished: false, waiting: true }
    });
  });
});
