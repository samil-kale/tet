import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { watchTranscriptDir } from "../../watch-dir";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { runOpencode } from "./cli";
import { renameDir, sessionsDir, type SessionRecord } from "./plugin";

/**
 * opencode keeps sessions in one SQLite database per machine, which tet never reads: the listing
 * is the plugin's records in agentDir (plugin.ts's SessionRecord), one per root session, host and
 * sandbox alike. There is no on-disk format to watch, and `opencode session list` boots a full
 * instance per call (~1.5 s measured, writing to the database) — anomalyco/opencode#37435. Only
 * the one-off actions below pay that.
 *
 * The cost: only sessions run through tet are known, and one removed elsewhere keeps its record
 * until a resume fails.
 */

/** Each repository's agentDir, registered by prepareSpawn (a provider only gets a cwd). Never cleared. */
const agentDirs = new Map<string, string>();

export function registerAgentDir(cwd: string, agentDir: string): void {
  agentDirs.set(cwd, agentDir);
}

function recordsDir(cwd: string): string | undefined {
  const agentDir = agentDirs.get(cwd);
  return agentDir ? sessionsDir(agentDir) : undefined;
}

/** The sandbox a session's record names; null on the host or without a record (only the host
 *  can hold an unrecorded session). */
export function sessionSandbox(cwd: string, sessionId: string): string | null {
  const dir = recordsDir(cwd);
  return (dir && readRecord(path.join(dir, `${sessionId}.json`))?.sandbox) ?? null;
}

/** How long a rename waits for the tab's opencode to apply it. */
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
    // Not ours, or damaged (never half-written: the plugin renames into place).
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
  // Records only (see the file header).
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

  /** `opencode session delete` where the record says the session is. The record goes with the
   *  session, or once the session or its sandbox is gone: a removed sandbox took its session with
   *  it. Any other failure keeps it, so a retry still looks where the session is.
   *
   *  An unknown session resolves (SessionProvider.remove). Measured (1.18.4): an unknown id exits 1
   *  with `Session not found: <id>`, in a sandbox too; a gone sandbox gets sbx's
   *  `sandbox '<name>' not found`. */
  async remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    const dir = recordsDir(cwd);
    try {
      await runOpencode(executable, cwd, sessionSandbox(cwd, sessionId), ["session", "delete", sessionId]);
    } catch (error) {
      if (!/Session not found|sandbox '[^']*' not found/.test(String(error))) {
        throw error;
      }
    }
    if (dir) {
      fs.rmSync(path.join(dir, `${sessionId}.json`), { force: true });
    }
  },

  /**
   * No `session rename` command, only the HTTP API of the server inside the tab's process. So a
   * request file is left for its plugin (plugin.ts's applyRenames); the rewritten record confirms
   * it. Without a running opencode it is withdrawn after the timeout. anomalyco/opencode#34751
   * exposed rename via the plugin API, not the CLI — revisit if `session rename <id> <title>` ships.
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
    writeFileAtomic.sync(request, trimmed);
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
    // The root is agentDir. A record written in a sandbox may raise no event across the bind
    // mount; the reconcile after a tab's output is the net.
    return watchTranscriptDir(
      () => path.dirname(dir),
      () => Promise.resolve(fs.existsSync(dir) ? dir : undefined),
      (filename) => filename.endsWith(".json"),
      onChange
    );
  }
};
