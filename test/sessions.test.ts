import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { claudeSessionProvider } from "../src/main/agents/claude/sessions";
import { codexSessionProvider } from "../src/main/agents/codex/sessions";

/**
 * The two agents whose sessions are read off disk, against transcripts written the way the
 * CLIs write them. The title rules and the turn forensics are what CLAUDE.md warns about: a
 * regression there shows the wrong title, or a spinner that never stops, with nothing to
 * catch it but this.
 */

const AT = "2026-03-04T10:00:00.000Z";
const LATER = "2026-03-04T10:05:00.000Z";
const ms = (iso: string): number => Date.parse(iso);
const line = (entry: unknown): string => (typeof entry === "string" ? entry : JSON.stringify(entry)) + "\n";

describe("Claude Code's transcripts", () => {
  const cwd = process.platform === "win32" ? "C:\\work\\Repo One" : "/work/repo one";
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");

  /** A config dir of its own per case: the provider caches by path, and every case is new. */
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
    const [session] = await claudeSessionProvider.list("claude", cwd);
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
    const titles = Object.fromEntries((await claudeSessionProvider.list("claude", cwd)).map((s) => [s.id, s]));
    assert.equal(titles.named.title, "Agent");
    assert.equal(titles.named.provisionalTitle, false);
    assert.equal(titles.titled.title, "Second", "the later ai-title supersedes");
    assert.equal(titles.summarized.title, "Sum");
    assert.equal(titles.renamed.title, "Mine", "a rename anywhere in the file wins");
    assert.equal(titles.other.title, "p", "another session's rename is not this one's");
  });

  it("collapses whitespace and cuts a long title at sixty characters", async () => {
    transcripts({ s: [prompt("  a\n\n   long   " + "x".repeat(80))] });
    const [session] = await claudeSessionProvider.list("claude", cwd);
    assert.equal(session.title.length, 60);
    assert.ok(session.title.startsWith("a long xxx") && session.title.endsWith("…"));
  });

  it("appends a rename the way Claude's own /rename does, and deletes a session with its sidecar", async () => {
    const dir = transcripts({ s: [prompt("p")] });
    await claudeSessionProvider.rename("claude", cwd, "s", "  Renamed  ");
    assert.equal((await claudeSessionProvider.list("claude", cwd))[0].title, "Renamed");
    fs.mkdirSync(path.join(dir, "s", "subagents"), { recursive: true });
    await claudeSessionProvider.remove("claude", cwd, "s");
    assert.deepEqual(fs.readdirSync(dir), []);
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
      background: [prompt("p"), turn("none", { pendingBackgroundAgentCount: 1 })],
      sidechain: [prompt("p"), turn("none", { isSidechain: true })]
    });
    const ends = Object.fromEntries(
      (await claudeSessionProvider.list("claude", cwd)).map((s) => [s.id, s.turnEndedAt])
    );
    assert.equal(ends.hooked, undefined, "the hooks ran — the marker is authoritative");
    assert.equal(ends.cut, ms(LATER), "no summary beneath it: interrupted");
    assert.equal(ends.cutAfterEarlier, ms(LATER), "an earlier turn's own summary is not this one's");
    assert.equal(ends.renamedBetween, undefined, "a rename between the two says nothing");
    assert.equal(ends.background, undefined, "subagents still running — the Stop hook holds back too");
    assert.equal(ends.sidechain, undefined, "a subagent's turn is not the session's");
  });

  it("orders by creation and survives a line that is not JSON", async () => {
    transcripts({
      newer: [prompt("second", LATER)],
      older: [prompt("first", AT)],
      broken: ["{ not json", prompt("still listed", AT)]
    });
    const sessions = await claudeSessionProvider.list("claude", cwd);
    assert.equal(sessions.at(-1)?.id, "newer");
    assert.equal(sessions.find((s) => s.id === "broken")?.title, "still listed");
  });

  it("lists nothing where Claude has never run", async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "tet-claude-never");
    assert.deepEqual(await claudeSessionProvider.list("claude", cwd), []);
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
    const sessions = await codexSessionProvider.list("codex", cwd);
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
    assert.equal((await codexSessionProvider.list("codex", cwd))[0].turnEndedAt, ms(LATER));
  });

  it("lists nothing where Codex has never run", async () => {
    process.env.CODEX_HOME = path.join(os.tmpdir(), "tet-codex-never");
    assert.deepEqual(await codexSessionProvider.list("codex", cwd), []);
  });
});
