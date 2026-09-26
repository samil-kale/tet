import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { claudeSessionProvider } from "../src/main/agents/claude/sessions";
import { codexSessionProvider } from "../src/main/agents/codex/sessions";
import { encodeCwd, piSessionProvider } from "../src/main/agents/pi/sessions";

/**
 * The session providers against transcripts written the way the CLIs write them. A regression in the title rules or turn forensics shows a
 * wrong title or a spinner that never stops, caught only here.
 */

const AT = "2026-03-04T10:00:00.000Z";
const LATER = "2026-03-04T10:05:00.000Z";
const ms = (iso: string): number => Date.parse(iso);
const line = (entry: unknown): string => (typeof entry === "string" ? entry : JSON.stringify(entry)) + "\n";

describe("Claude Code's transcripts", () => {
  const cwd = process.platform === "win32" ? "C:\\work\\Repo One" : "/work/repo one";
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");

  /** A fresh config dir per case: the provider caches by path. */
  function transcripts(files: Record<string, unknown[]>): string {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-claude-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const projectDir = path.join(configDir, "projects", encoded);
    fs.mkdirSync(projectDir, { recursive: true });
    for (const [id, entries] of Object.entries(files)) {
      fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), entries.map(line).join(""));
    }
    return projectDir;
  }

  const prompt = (text: string, timestamp = AT): unknown => ({
    type: "user",
    timestamp,
    origin: { kind: "human" },
    message: { content: text }
  });
  const toolResult = { type: "user", message: { content: "tool output, not a prompt" } };

  it("labels a session by its first typed prompt until Claude names it", async () => {
    transcripts({ s1: [toolResult, prompt("Fix the build"), prompt("and the tests")] });
    const [session] = await claudeSessionProvider.list(cwd);
    assert.equal(session.id, "s1");
    assert.equal(session.title, "Fix the build");
    assert.equal(session.provisionalTitle, true);
    assert.equal(session.createdAt, ms(AT), "the first timestamp, not the mtime");
  });

  it("ranks custom-title over agent-name over ai-title over summary over the prompt", async () => {
    transcripts({
      named: [
        prompt("p"),
        { type: "summary", summary: "Sum" },
        { type: "ai-title", aiTitle: "Title" },
        { type: "agent-name", agentName: "Agent" }
      ],
      titled: [
        prompt("p"),
        { type: "summary", summary: "Sum" },
        { type: "ai-title", aiTitle: "First" },
        { type: "ai-title", aiTitle: "Second" }
      ],
      summarized: [prompt("p"), { type: "summary", summary: "Sum" }],
      renamed: [
        { type: "custom-title", customTitle: "Mine", sessionId: "renamed" },
        prompt("p"),
        { type: "agent-name", agentName: "Agent" }
      ],
      other: [{ type: "custom-title", customTitle: "Not mine", sessionId: "someone-else" }, prompt("p")]
    });
    const titles = Object.fromEntries((await claudeSessionProvider.list(cwd)).map((s) => [s.id, s]));
    assert.equal(titles.named.title, "Agent");
    assert.equal(titles.named.provisionalTitle, false);
    assert.equal(titles.titled.title, "Second", "the later ai-title supersedes");
    assert.equal(titles.summarized.title, "Sum");
    assert.equal(titles.renamed.title, "Mine", "a rename anywhere in the file wins");
    assert.equal(titles.other.title, "p", "another session's rename is not this one's");
  });

  it("collapses whitespace and cuts a long title at sixty characters", async () => {
    transcripts({ s: [prompt("  a\n\n   long   " + "x".repeat(80))] });
    const [session] = await claudeSessionProvider.list(cwd);
    assert.equal(session.title.length, 60);
    assert.ok(session.title.startsWith("a long xxx") && session.title.endsWith("…"));
  });

  it("appends a rename the way Claude's own /rename does, and deletes a session with its sidecar", async () => {
    const dir = transcripts({ s: [prompt("p")] });
    await claudeSessionProvider.rename("claude", cwd, "s", "  Renamed  ");
    assert.equal((await claudeSessionProvider.list(cwd))[0].title, "Renamed");
    fs.mkdirSync(path.join(dir, "s", "subagents"), { recursive: true });
    await claudeSessionProvider.remove("claude", cwd, "s");
    assert.deepEqual(fs.readdirSync(dir), []);
    // A session that is already gone resolves — see SessionProvider.remove.
    await claudeSessionProvider.remove("claude", cwd, "s");
    await assert.rejects(claudeSessionProvider.rename("claude", cwd, "s", "  "), /non-empty/);
  });

  it("reports when a turn ended without its Stop hooks, and only then", async () => {
    const turn = (parentUuid: string, extra: Record<string, unknown> = {}): unknown => ({
      type: "system",
      subtype: "turn_duration",
      timestamp: LATER,
      parentUuid,
      uuid: "t",
      ...extra
    });
    const interrupt = (text: string, timestamp = LATER, extra: Record<string, unknown> = {}): unknown => ({
      type: "user",
      timestamp,
      message: { role: "user", content: [{ type: "text", text }] },
      ...extra
    });
    transcripts({
      hooked: [prompt("p"), { type: "system", subtype: "stop_hook_summary", uuid: "h1" }, turn("h1")],
      cut: [prompt("p"), turn("nothing-below")],
      cutAfterEarlier: [
        prompt("p"),
        { type: "system", subtype: "stop_hook_summary", uuid: "h0" },
        turn("h0"),
        turn("h9")
      ],
      renamedBetween: [
        prompt("p"),
        { type: "system", subtype: "stop_hook_summary", uuid: "h1" },
        { type: "custom-title", customTitle: "x", sessionId: "renamedBetween" },
        turn("h1")
      ],
      sidechain: [prompt("p"), turn("none", { isSidechain: true })],
      escaped: [
        prompt("p"),
        { type: "system", subtype: "stop_hook_summary", uuid: "h0" },
        turn("h0", { timestamp: AT }),
        prompt("q"),
        interrupt("[Request interrupted by user]")
      ],
      escapedInTool: [
        prompt("p"),
        { type: "system", subtype: "stop_hook_summary", uuid: "h0" },
        turn("h0", { timestamp: AT }),
        interrupt("[Request interrupted by user for tool use]", AT),
        turn("i1")
      ],
      escapedInSidechain: [prompt("p"), interrupt("[Request interrupted by user]", LATER, { isSidechain: true })]
    });
    const ends = Object.fromEntries(
      (await claudeSessionProvider.list(cwd)).map((s) => [s.id, s.turnEndedAt])
    );
    assert.equal(ends.hooked, undefined, "the hooks ran — the marker is authoritative");
    assert.equal(ends.cut, ms(LATER), "no summary beneath it: interrupted");
    assert.equal(ends.cutAfterEarlier, ms(LATER), "an earlier turn's own summary is not this one's");
    assert.equal(ends.renamedBetween, undefined, "a rename between the two says nothing");
    assert.equal(ends.sidechain, undefined, "a subagent's turn is not the session's");
    assert.equal(ends.escaped, ms(LATER), "Escape outside a tool writes no turn_duration, only the interrupt");
    assert.equal(ends.escapedInTool, ms(LATER), "Escape during a tool writes both; the turn_duration dates it");
    assert.equal(ends.escapedInSidechain, undefined, "a subagent's interrupt is not the session's");
  });

  it("orders by creation and survives a line that is not JSON", async () => {
    transcripts({
      newer: [prompt("second", LATER)],
      older: [prompt("first", AT)],
      broken: ["{ not json", prompt("still listed", AT)]
    });
    const sessions = await claudeSessionProvider.list(cwd);
    assert.equal(sessions.at(-1)?.id, "newer");
    assert.equal(sessions.find((s) => s.id === "broken")?.title, "still listed");
  });

  it("lists nothing where Claude has never run", async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "tet-claude-never");
    assert.deepEqual(await claudeSessionProvider.list(cwd), []);
  });
});

describe("Codex's rollouts", () => {
  const cwd = process.platform === "win32" ? "C:\\work\\Repo" : "/work/repo";

  function rollouts(files: Record<string, unknown[]>, index: unknown[] = []): void {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tet-codex-"));
    process.env.CODEX_HOME = home;
    const day = path.join(home, "sessions", "2026", "03", "04");
    fs.mkdirSync(day, { recursive: true });
    for (const [name, entries] of Object.entries(files)) {
      fs.writeFileSync(path.join(day, `rollout-${name}.jsonl`), entries.map(line).join(""));
    }
    if (index.length > 0) {
      fs.writeFileSync(path.join(home, "session_index.jsonl"), index.map(line).join(""));
    }
  }

  const meta = (session_id: string, source = "cli", at = AT, dir = cwd): unknown => ({
    type: "session_meta",
    timestamp: at,
    payload: { session_id, cwd: dir, source }
  });
  const injected = {
    type: "response_item",
    payload: { role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] }
  };
  const typed = (text: string): unknown => ({ type: "event_msg", payload: { type: "user_message", message: text } });
  const end = (type: string, at = LATER): unknown => ({ type: "event_msg", timestamp: at, payload: { type } });

  it("lists this repository's interactive sessions only, titled by the index or the first prompt", async () => {
    rollouts(
      {
        one: [meta("s1"), injected, typed("Add tests"), end("task_complete")],
        two: [
          meta("s2", "cli", LATER),
          injected,
          { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Typed the other way" }] } }
        ],
        exec: [meta("s3", "exec"), typed("not interactive")],
        elsewhere: [meta("s4", "cli", AT, "/somewhere/else"), typed("other repo")],
        empty: []
      },
      [{ id: "s1", thread_name: "Named" }, { id: "s2", thread_name: "Cleared" }, { id: "s2", thread_name: "" }]
    );
    const sessions = await codexSessionProvider.list(cwd);
    assert.deepEqual(
      sessions.map((s) => [s.id, s.title, s.turnEndedAt, s.createdAt]),
      [
        ["s1", "Named", ms(LATER), ms(AT)],
        ["s2", "Typed the other way", undefined, ms(LATER)]
      ]
    );
  });

  it("takes an aborted turn as an end too, and the last one", async () => {
    rollouts({ one: [meta("s1"), typed("p"), end("task_complete", AT), end("turn_aborted", LATER)] });
    assert.equal((await codexSessionProvider.list(cwd))[0].turnEndedAt, ms(LATER));
  });

  it("lists nothing where Codex has never run", async () => {
    process.env.CODEX_HOME = path.join(os.tmpdir(), "tet-codex-never");
    assert.deepEqual(await codexSessionProvider.list(cwd), []);
  });
});

describe("pi's transcripts", () => {
  const cwd = process.platform === "win32" ? "C:\\work\\Repo One" : "/work/repo one";
  const fileName = (id: string, at = AT): string => `${at.replace(/[:.]/g, "-")}_${id}.jsonl`;

  /** A fresh config dir per case: the provider caches by path. */
  function transcripts(files: Record<string, unknown[]>, dirName = encodeCwd(cwd)): string {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "tet-pi-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sessionDir = path.join(agentDir, "sessions", dirName);
    fs.mkdirSync(sessionDir, { recursive: true });
    for (const [id, entries] of Object.entries(files)) {
      fs.writeFileSync(path.join(sessionDir, fileName(id)), entries.map(line).join(""));
    }
    return sessionDir;
  }

  const header = (id: string, at = AT): unknown => ({ type: "session", version: 3, id, timestamp: at, cwd });
  const modelChange = { type: "model_change", id: "m1", parentId: null, timestamp: AT, provider: "x", modelId: "y" };
  const user = (content: unknown, id = "u1", at = AT): unknown => ({
    type: "message",
    id,
    parentId: "m1",
    timestamp: at,
    message: { role: "user", content, timestamp: ms(at) }
  });
  const assistant = (stopReason: string, at = AT, id = "a1"): unknown => ({
    type: "message",
    id,
    parentId: "u1",
    timestamp: at,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason, timestamp: ms(at) }
  });
  const toolResult = { type: "message", id: "t1", parentId: "a1", timestamp: AT, message: { role: "toolResult", content: [{ type: "text", text: "user output" }] } };
  const info = (name: string, id: string): unknown => ({ type: "session_info", id, parentId: "a1", timestamp: LATER, name });

  it("titles a session by the last session_info in file order, else by the first prompt", async () => {
    transcripts({
      s1: [header("s1"), modelChange, user("Fix the build"), assistant("stop"), info("First", "n1"), info("Second", "n2")],
      s2: [header("s2", LATER), modelChange, toolResult, user([{ type: "image", data: "…" }, { type: "text", text: "From blocks" }]), assistant("stop")],
      s3: [header("s3", LATER), modelChange, user("Fix the tests"), assistant("stop"), info("Mine", "n1"), info("  ", "n2")]
    });
    const sessions = await piSessionProvider.list(cwd);
    assert.deepEqual(
      sessions.map((s) => [s.id, s.title, s.createdAt, s.provisionalTitle]),
      [
        ["s1", "Second", ms(AT), undefined],
        ["s2", "From blocks", ms(LATER), undefined],
        ["s3", "Fix the tests", ms(LATER), undefined]
      ],
      "the header's timestamp is the created time, a blank last session_info is pi's own clear"
    );
  });

  it("takes the last assistant message as the turn's end, an aborted one included", async () => {
    transcripts({
      s1: [header("s1"), modelChange, user("p"), assistant("stop", AT), user("q", "u2"), assistant("aborted", LATER, "a2")],
      s2: [header("s2", LATER), modelChange, user("p")]
    });
    const sessions = await piSessionProvider.list(cwd);
    assert.deepEqual(sessions.map((s) => [s.id, s.turnEndedAt]), [["s1", ms(LATER)], ["s2", undefined]]);
  });

  it("does not take an assistant message calling a tool as the turn's end", async () => {
    transcripts({
      s1: [header("s1"), modelChange, user("p"), assistant("stop", AT), user("q", "u2"), assistant("toolUse", LATER, "a2"), toolResult]
    });
    const sessions = await piSessionProvider.list(cwd);
    assert.deepEqual(sessions.map((s) => [s.id, s.turnEndedAt]), [["s1", ms(AT)]]);
  });

  it("renames by appending a session_info parented to the last entry, and removes by deleting the file", async () => {
    const dir = transcripts({ s1: [header("s1"), modelChange, user("p"), assistant("stop")] });
    await piSessionProvider.rename("pi", cwd, "s1", "  Renamed  ");
    assert.equal((await piSessionProvider.list(cwd))[0].title, "Renamed");
    const lines = fs.readFileSync(path.join(dir, fileName("s1")), "utf8").trim().split("\n");
    const appended = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    assert.equal(appended.type, "session_info");
    assert.equal(appended.name, "Renamed");
    assert.equal(appended.parentId, "a1");
    assert.match(String(appended.id), /^[0-9a-f]{8}$/);
    assert.ok(!["m1", "u1", "a1"].includes(String(appended.id)));
    await assert.rejects(piSessionProvider.rename("pi", cwd, "s1", "  "), /non-empty/);
    await piSessionProvider.remove("pi", cwd, "s1");
    assert.deepEqual(fs.readdirSync(dir), []);
    // A session that is already gone resolves — see SessionProvider.remove.
    await piSessionProvider.remove("pi", cwd, "s1");
  });

  it("skips a .jsonl that is no pi transcript, and reads past a broken line", async () => {
    transcripts({
      other: [{ type: "message", id: "x" }],
      s1: [header("s1"), "{ not json", user("Still listed"), assistant("stop")]
    });
    const sessions = await piSessionProvider.list(cwd);
    assert.deepEqual(sessions.map((s) => [s.id, s.title]), [["s1", "Still listed"]]);
  });

  it("finds the directory whatever case pi was spawned with", { skip: process.platform !== "win32" && "win32 only" }, async () => {
    transcripts({ s1: [header("s1"), modelChange, user("p"), assistant("stop")] }, encodeCwd(cwd).toLowerCase());
    assert.equal((await piSessionProvider.list(cwd))[0]?.id, "s1");
  });

  it("lists nothing where pi has never run", async () => {
    process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "tet-pi-never");
    assert.deepEqual(await piSessionProvider.list(cwd), []);
  });
});

/**
 * The providers read through the directory tet mounts into an sbx sandbox: paths are the
 * container's (`/c/work/...`, as `toContainerPath` makes them) and the root is the mounted host
 * directory. The CLI writes byte-for-byte what it writes on the host; only these two inputs differ.
 */
describe("sessions written inside a sandbox", () => {
  const cwd = "/c/work/Repo One";

  function root(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  it("lists, renames and deletes Claude's sandboxed transcripts", async () => {
    const dir = root("tet-sbx-claude-");
    const projectDir = path.join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "s1.jsonl"),
      [{ type: "user", timestamp: AT, origin: { kind: "human" }, message: { content: "In the sandbox" } }].map(line).join("")
    );
    const sandbox = claudeSessionProvider.sandbox;
    assert.ok(sandbox);
    const [session] = await sandbox.list(dir, cwd);
    assert.equal(session.id, "s1");
    assert.equal(session.title, "In the sandbox");
    await sandbox.rename(dir, cwd, "s1", "Renamed");
    assert.equal((await sandbox.list(dir, cwd))[0].title, "Renamed");
    await sandbox.remove(dir, cwd, "s1");
    assert.deepEqual(await sandbox.list(dir, cwd), []);
  });

  it("lists, renames and deletes Codex's sandboxed rollouts on the mounted files", async () => {
    const dir = root("tet-sbx-codex-");
    const day = path.join(dir, "sessions", "2026", "03", "04");
    fs.mkdirSync(day, { recursive: true });
    for (const [id, at] of [["s1", AT], ["s2", LATER]]) {
      fs.writeFileSync(
        path.join(day, `rollout-${id}.jsonl`),
        [
          { type: "session_meta", timestamp: at, payload: { session_id: id, cwd, source: "cli" } },
          { type: "event_msg", payload: { type: "user_message", message: "In the sandbox" } }
        ]
          .map(line)
          .join("")
      );
    }
    const index = path.join(dir, "session_index.jsonl");
    fs.writeFileSync(index, line({ id: "s1", thread_name: "Named" }));
    const sandbox = codexSessionProvider.sandbox;
    assert.ok(sandbox);
    const titles = async (): Promise<string[][]> => (await sandbox.list(dir, cwd)).map((s) => [s.id, s.title]);
    assert.deepEqual(await titles(), [["s1", "Named"], ["s2", "In the sandbox"]], "the name index beside the rollouts is mounted too");

    await sandbox.rename(dir, cwd, "s2", "  Renamed  ");
    assert.deepEqual(await titles(), [["s1", "Named"], ["s2", "Renamed"]]);
    const appended = JSON.parse(fs.readFileSync(index, "utf8").trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    assert.deepEqual(Object.keys(appended), ["id", "thread_name", "updated_at"]);
    assert.match(String(appended.updated_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/, "Codex's seven fractional digits");
    await assert.rejects(sandbox.rename(dir, cwd, "s2", "  "), /non-empty/);

    const indexBefore = fs.readFileSync(index, "utf8");
    await sandbox.remove(dir, cwd, "s1");
    assert.deepEqual(fs.readdirSync(day), ["rollout-s2.jsonl"]);
    assert.equal(fs.readFileSync(index, "utf8"), indexBefore, "the index is left as it is");
    assert.deepEqual(await titles(), [["s2", "Renamed"]], "a name without its rollout lists nothing");
    // A session that is already gone resolves — see SessionProvider.remove.
    await sandbox.remove(dir, cwd, "s1");
  });

  it("lists, renames and deletes pi's sandboxed transcripts", async () => {
    const dir = root("tet-sbx-pi-");
    // Spelled out, not encodeCwd: pi on the sandbox's Linux encodes the container path, which a
    // win32 host would resolve as `C:\c\work\...`.
    const sessionDir = path.join(dir, "sessions", "--c-work-Repo One--");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${AT.replace(/[:.]/g, "-")}_s1.jsonl`),
      [
        { type: "session", version: 3, id: "s1", timestamp: AT, cwd },
        { type: "model_change", id: "m1", parentId: null, timestamp: AT, provider: "x", modelId: "y" },
        { type: "message", id: "u1", parentId: "m1", timestamp: AT, message: { role: "user", content: "In the sandbox", timestamp: ms(AT) } }
      ]
        .map(line)
        .join("")
    );
    const sandbox = piSessionProvider.sandbox;
    assert.ok(sandbox);
    const [session] = await sandbox.list(dir, cwd);
    assert.equal(session.id, "s1");
    assert.equal(session.title, "In the sandbox");
    await sandbox.rename(dir, cwd, "s1", "Renamed");
    assert.equal((await sandbox.list(dir, cwd))[0].title, "Renamed");
    await sandbox.remove(dir, cwd, "s1");
    assert.deepEqual(await sandbox.list(dir, cwd), []);
  });

  it("has nothing to list where the sandbox never wrote anything", async () => {
    const dir = path.join(os.tmpdir(), "tet-sbx-never");
    for (const provider of [claudeSessionProvider, codexSessionProvider, piSessionProvider]) {
      assert.deepEqual(await provider.sandbox?.list(dir, cwd), []);
    }
  });
});
