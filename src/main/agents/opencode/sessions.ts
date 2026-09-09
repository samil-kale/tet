import * as fs from "node:fs";
import * as path from "node:path";
import { watchTranscriptDir } from "../../watch-dir";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { runOpencode } from "./cli";
import { renameDir, sessionsDir, type SessionRecord } from "./plugin";

/**
 * opencode keeps its sessions in one SQLite database per machine (`opencode.db` under its data
 * directory, and a sandbox's inside the sandbox), which nothing here reads: the listing is the
 * records the generated plugin writes into tet's own agentDir (plugin.ts's SessionRecord), one
 * file per root session, host and sandboxed alike — the same source wherever the tab ran.
 * Reading them costs what reading Claude Code's transcripts costs; asking opencode instead
 * boots a process per question (~1.5 s measured, writing to the database on every one), which
 * is what the one-off actions below pay and a listing never does.
 *
 * The cost of that: tet knows the sessions that ran through it. One started elsewhere (a plain
 * `opencode` in a shell) leaves no record — except once, when a repository is listed for the
 * first time after the records replaced the server (see seed).
 */

/** Where each repository's records are, registered by prepareSpawn: a provider gets a cwd, not
 *  an agentDir, and the two are only ever paired there. Never cleared — the directory outlives
 *  any preparation, and the strings are cheap. */
const agentDirs = new Map<string, string>();

export function registerAgentDir(cwd: string, agentDir: string): void {
  agentDirs.set(cwd, agentDir);
}

function recordsDir(cwd: string): string | undefined {
  const agentDir = agentDirs.get(cwd);
  return agentDir ? sessionsDir(agentDir) : undefined;
}

/** The sandbox a session's record names, or null for one on the host — and for one without a
 *  record, since the host is the only place an unrecorded session could be. */
export function sessionSandbox(cwd: string, sessionId: string): string | null {
  const dir = recordsDir(cwd);
  return (dir && readRecord(path.join(dir, `${sessionId}.json`))?.sandbox) ?? null;
}

/** How long a rename waits for the tab's opencode to apply it before it is called off. */
const RENAME_TIMEOUT_MS = 5000;
const RENAME_POLL_MS = 250;

/** Written once the seeding ran, so a repository with no sessions is not seeded on every start. */
const SEEDED_MARKER = ".seeded";

function readRecord(file: string): SessionRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SessionRecord>;
    if (typeof parsed.id !== "string") {
      return undefined;
    }
    return {
      id: parsed.id,
      title: typeof parsed.title === "string" ? parsed.title : "",
      created: typeof parsed.created === "number" ? parsed.created : 0,
      updated: typeof parsed.updated === "number" ? parsed.updated : 0,
      sandbox: typeof parsed.sandbox === "string" ? parsed.sandbox : null
    };
  } catch {
    // Half-written (the plugin renames into place, but a stray .tmp is listed too) or not ours.
    return undefined;
  }
}

function readRecords(dir: string): SessionRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json")).flatMap((name) => readRecord(path.join(dir, name)) ?? []);
}

function writeRecord(dir: string, record: SessionRecord): void {
  const file = path.join(dir, `${record.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * The one time opencode itself is asked for a listing: a repository whose records directory
 * has never been filled, so the sessions from before the records existed become tabs again
 * after the update that introduced them. `session list --format json` names every session the
 * database holds with its directory (measured), so it is filtered to this repository here; the
 * CLI knows no `roots` filter, but lists conversations only, the same as opencode's own picker.
 * On the host only: a sandbox's database starts empty, and its plugin records from the first
 * session on. A failure leaves the marker unwritten for the next start to try again — not the
 * next listing, which follows every tab's output and would spend a process each time.
 */
const seedTried = new Set<string>();

async function seed(executable: string, cwd: string, dir: string): Promise<void> {
  const marker = path.join(dir, SEEDED_MARKER);
  if (seedTried.has(dir) || fs.existsSync(marker)) {
    return;
  }
  seedTried.add(dir);
  try {
    const output = await runOpencode(executable, cwd, null, ["session", "list", "--format", "json"]);
    const entries = (output.trim() ? JSON.parse(output) : []) as {
      id?: unknown;
      title?: unknown;
      directory?: unknown;
      created?: unknown;
      updated?: unknown;
    }[];
    const here = path.resolve(cwd).toLowerCase();
    for (const entry of entries) {
      if (typeof entry.id !== "string" || typeof entry.directory !== "string" || path.resolve(entry.directory).toLowerCase() !== here) {
        continue;
      }
      if (fs.existsSync(path.join(dir, `${entry.id}.json`))) {
        continue;
      }
      writeRecord(dir, {
        id: entry.id,
        title: typeof entry.title === "string" ? entry.title : "",
        created: typeof entry.created === "number" ? entry.created : 0,
        updated: typeof entry.updated === "number" ? entry.updated : 0,
        sandbox: null
      });
    }
    fs.writeFileSync(marker, "");
  } catch (error) {
    console.error("[tet] opencode session seeding failed:", error);
  }
}

export const opencodeSessionProvider: SessionProvider = {
  async list(executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    const dir = recordsDir(cwd);
    if (!dir) {
      return [];
    }
    await seed(executable, cwd, dir);
    return readRecords(dir)
      .map((record) => ({
        id: record.id,
        title: record.title,
        updatedAt: record.updated,
        createdAt: record.created,
        sandbox: record.sandbox ?? undefined
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },

  resumeArgs(sessionId: string): string[] {
    return ["--session", sessionId];
  },

  /**
   * `opencode session delete`, run where the session is — the record says whether that is a
   * sandbox. The record goes whatever opencode said: a session whose sandbox was removed
   * (SBX turned off for the project) is gone with it, and the record is all that is left.
   */
  async remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    const dir = recordsDir(cwd);
    try {
      await runOpencode(executable, cwd, sessionSandbox(cwd, sessionId), ["session", "delete", sessionId]);
    } finally {
      if (dir) {
        fs.rmSync(path.join(dir, `${sessionId}.json`), { force: true });
      }
    }
  },

  /**
   * opencode has no `session rename` command, only the HTTP API — and the one server there is
   * runs inside the tab's own process. So the title is left for that process's plugin to
   * apply (plugin.ts's applyRenames), and the session's record, which opencode's own update
   * event then rewrites, is what says it landed. A tab whose opencode is not running has no
   * one to apply it: the request is withdrawn after the timeout and the caller told.
   */
  async rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title must be non-empty");
    }
    const agentDir = agentDirs.get(cwd);
    if (!agentDir) {
      throw new Error("opencode has not been prepared for this repository");
    }
    const requests = renameDir(agentDir);
    fs.mkdirSync(requests, { recursive: true });
    const request = path.join(requests, sessionId);
    fs.writeFileSync(`${request}.tmp`, trimmed);
    fs.renameSync(`${request}.tmp`, request);
    const recordFile = path.join(sessionsDir(agentDir), `${sessionId}.json`);
    const deadline = Date.now() + RENAME_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RENAME_POLL_MS));
      if (readRecord(recordFile)?.title === trimmed) {
        return;
      }
    }
    fs.rmSync(request, { force: true });
    throw new Error("the session's opencode is not running — start its tab, then rename it");
  },

  watch(executable: string, cwd: string, onChange: () => void): () => void {
    const dir = recordsDir(cwd);
    if (!dir) {
      return () => undefined;
    }
    // The records directory exists from prepareSpawn on; the root above it is agentDir. A
    // record written from inside a sandbox may not raise an event on this side of the bind
    // mount — the reconcile that follows a tab's output is the net, as it is for the markers.
    return watchTranscriptDir(
      () => path.dirname(dir),
      () => Promise.resolve(fs.existsSync(dir) ? dir : undefined),
      (filename) => filename.endsWith(".json"),
      onChange
    );
  }
};
