import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkSbxReady, listSandboxes, readSbxReading, readSbxSignedIn } from "../../src/main/sbx/sbx-status";
import { fakeCommand, tempDir, withCommandOn } from "../helpers";

/** sbx/sbx-status.ts: whether sbx is ready for a sandboxed tab, as its probe reads it. */

interface Answers {
  /** `sbx version --json`'s client version; none exits 1, as a missing sbx does not answer. */
  version?: string;
  /** `sbx ls --json`: the sandboxes, or the stderr it fails with. */
  sandboxes?: Record<string, string[]>;
  lsFails?: string;
  /** `sbx policy ls --type filesystem --json`: its rules, or none for a policy never set up. */
  filesystemRules?: object[];
  /** `sbx policy ls`'s whole stdout, where the rules alone do not say it (a governed account). */
  policyStdout?: string;
}

const ALLOW_ALL = [{ resource_type: "filesystem", decision: "allow", resources: ["**"] }];

/** A stand-in `sbx` answering the probe's commands from `answers`, run with it first on PATH. */
async function withSbx<T>(answers: Answers, action: (folder: string) => Promise<T>): Promise<T> {
  const dir = tempDir("tet-sbx-status-");
  const folder = path.join(dir, "repo");
  fs.mkdirSync(folder);
  fakeCommand(
    dir,
    "sbx",
    `const answers = ${JSON.stringify(answers)};
const args = process.argv.slice(2).join(" ");
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
if (args.startsWith("version")) {
  answers.version === undefined ? fail("unknown command") : out({ client: { version: "v" + answers.version } });
} else if (args.startsWith("ls")) {
  answers.lsFails !== undefined ? fail(answers.lsFails) : out({ sandboxes: Object.entries(answers.sandboxes ?? {}).map(([name, workspaces]) => ({ name, workspaces })) });
} else if (args.startsWith("policy ls")) {
  answers.filesystemRules === undefined ? fail("no policy") : out(answers.policyStdout ?? { rules: answers.filesystemRules });
} else if (args.startsWith("policy check")) {
  out({ allowed: true });
}
`,
  );
  return withCommandOn(dir, () => action(folder));
}

const REF = { projectId: "p" };

describe("whether sbx is ready for a sandboxed tab", () => {
  it("names the first setup step still missing: installed, new enough, signed in, a policy", async () => {
    const notReady = (answers: Answers) => withSbx(answers, async (folder) => (await checkSbxReady(folder, REF)) as { notReady?: string });

    assert.equal((await notReady({})).notReady, "SBX is not installed, too old or no longer on PATH");
    assert.match(
      (await notReady({ version: "0.44.2", sandboxes: {}, filesystemRules: ALLOW_ALL })).notReady ?? "",
      /^SBX failed: version 0\.44\.2 is too old/,
    );
    assert.equal(
      (await notReady({ version: "0.45.1", lsFails: "Not authenticated to Docker" })).notReady,
      "SBX is not signed in to Docker",
    );
    assert.match((await notReady({ version: "0.45.1", lsFails: "the daemon is down" })).notReady ?? "", /^SBX failed: /);
    assert.equal((await notReady({ version: "0.45.1", sandboxes: {} })).notReady, "SBX's network policy is not set up");
  });

  it("says what the policy does not allow, with the rule to ask for", async () => {
    const answers: Answers = { version: "0.45.1", sandboxes: {}, filesystemRules: [] };
    const { notReady } = await withSbx(answers, async (folder) => (await checkSbxReady(folder, REF)) as { notReady?: string });
    assert.match(notReady ?? "", /^SBX's policy does not allow .*\(The project\)/);
  });

  it("answers the sandboxes and the rules a spawn is prepared with once everything is in place", async () => {
    const answers: Answers = { version: "0.45.1", sandboxes: { "tet-claude-abc": ["/work"] }, filesystemRules: ALLOW_ALL };
    const ready = await withSbx(answers, (folder) => checkSbxReady(folder, REF));
    assert.ok(!("notReady" in ready), JSON.stringify(ready));
    assert.deepEqual([...ready.sandboxes], [["tet-claude-abc", ["/work"]]]);
    assert.equal(ready.rules?.length, 1);
  });
});

describe("what the SBX Settings read of sbx", () => {
  it("reads the status with the sandboxes and rules read on the way, and the blockers only once a policy is set up", async () => {
    const ready = await withSbx({ version: "0.45.1", sandboxes: { a: [] }, filesystemRules: ALLOW_ALL }, (folder) =>
      readSbxReading(folder, REF, false),
    );
    assert.equal(ready.status.installed, true);
    assert.equal(ready.status.signedIn, true);
    assert.equal(ready.status.policyInitialized, true);
    assert.deepEqual(ready.status.blockers, []);
    assert.deepEqual([...(ready.sandboxes ?? [])], [["a", []]]);
    assert.equal(ready.rules?.length, 1);

    const noPolicy = await withSbx({ version: "0.45.1", sandboxes: {} }, (folder) => readSbxReading(folder, REF, false));
    assert.equal(noPolicy.status.policyInitialized, false);
    assert.equal(noPolicy.rules, undefined, "no rules are asked of a policy that is not there");
  });

  it("names the organization governing the policy, in the status and in what it does not allow", async () => {
    const policyStdout = JSON.stringify({ rules: [], organization: "Acme" });
    const answers: Answers = { version: "0.45.1", sandboxes: {}, filesystemRules: [], policyStdout };
    const { status } = await withSbx(answers, (folder) => readSbxReading(folder, REF, false));
    assert.equal(status.organization, "Acme");
    const { notReady } = await withSbx(answers, async (folder) => (await checkSbxReady(folder, REF)) as { notReady?: string });
    assert.match(notReady ?? "", /^Acme's SBX policy does not allow /);
  });

  it("reads signed in off the sandbox listing, and no listing off a failure", async () => {
    assert.equal(await withSbx({ version: "0.45.1", sandboxes: {} }, () => readSbxSignedIn()), true);
    assert.equal(await withSbx({ version: "0.45.1", lsFails: "Not authenticated to Docker" }, () => readSbxSignedIn()), false);
    assert.equal(await withSbx({ lsFails: "x" }, () => listSandboxes()), undefined);
  });
});
