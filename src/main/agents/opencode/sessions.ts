import * as fs from "node:fs";
import * as path from "node:path";
import { watchTranscriptDir } from "../../watch-dir";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { runOpencode } from "./cli";
import { renameDir, sessionsDir, type SessionRecord } from "./plugin";

/**
 * opencode keeps its sessions in one SQLite database per machine, which nothing here reads: the
 * listing is the records the generated plugin writes into tet's own agentDir (plugin.ts's
 * SessionRecord), one file per root session, host and sandboxed alike. There is no on-disk
 * session format to read or watch instead, and `opencode session list` boots a full instance per
 * call (~1.5 s measured, writing to the database each time) — anomalyco/opencode#37435. That is
 * what the one-off actions below pay and a listing never does.
 *
 * The cost: tet knows the sessions that ran through it. One started elsewhere leaves no record.
 * One removed elsewhere keeps its record until a resume of it fails.
 */

/** Where each repository's records are, registered by prepareSpawn: a provider gets a cwd, not an
 *  agentDir, and the two are only ever paired there. Never cleared. */
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

export const opencodeSessionProvider: SessionProvider = {
  // Reads only the records (see the file header): a session deleted from outside tet is listed
  // as if it existed until a tab tries to resume it and fails.
  list(_executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    const dir = recordsDir(cwd);
    if (!dir) {
      return Promise.resolve([]);
    }
    const sessions = readRecords(dir)
      .map((record) => ({
        id: record.id,
        title: record.title,
        updatedAt: record.updated,
        createdAt: record.created,
        sandbox: record.sandbox ?? undefined
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
    return Promise.resolve(sessions);
  },

  resumeArgs(sessionId: string): string[] {
    return ["--session", sessionId];
  },

  /** `opencode session delete`, run where the session is — the record says whether that is a
   *  sandbox. The record goes whatever opencode said: a session whose sandbox was removed is
   *  gone with it, and the record is all that is left.
   *
   *  A session opencode no longer knows is already deleted — resolved, not rejected, per
   *  SessionProvider.remove. Measured (1.18.4): `session delete <unknown id>` exits 1 with
   *  `Session not found: <id>` on stderr. */
  async remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    const dir = recordsDir(cwd);
    try {
      await runOpencode(executable, cwd, sessionSandbox(cwd, sessionId), ["session", "delete", sessionId]);
    } catch (error) {
      if (!String(error).includes("Session not found")) {
        throw error;
      }
    } finally {
      if (dir) {
        fs.rmSync(path.join(dir, `${sessionId}.json`), { force: true });
      }
    }
  },

  /**
   * opencode has no `session rename` command, only the HTTP API — and the one server there is
   * runs inside the tab's own process. So the title is left for that process's plugin to apply
   * (plugin.ts's applyRenames), and the record it rewrites is what says it landed. A tab whose
   * opencode is not running has no one to apply it: the request is withdrawn after the timeout.
   * anomalyco/opencode#34751 was closed by exposing rename through the plugin/tool API, not a
   * CLI subcommand — revisit only if `session rename <id> <title>` actually ships.
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
    // The records directory exists from prepareSpawn on; the root above it is agentDir. A record
    // written inside a sandbox may raise no event on this side of the bind mount — the reconcile
    // that follows a tab's output is the net.
    return watchTranscriptDir(
      () => path.dirname(dir),
      () => Promise.resolve(fs.existsSync(dir) ? dir : undefined),
      (filename) => filename.endsWith(".json"),
      onChange
    );
  }
};
