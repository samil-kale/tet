import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { watchTranscriptDir } from "../../watch-dir";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { collectSessions, requireTitle } from "../transcript";
import { sandboxExists } from "../../sbx";
import { listOpencodeSessions, runOpencode } from "./cli";
import { renameDir, sessionsDir, type SessionRecord } from "./plugin";

/**
 * opencode keeps sessions in one SQLite database per machine (and one per sandbox), which tet never
 * reads: the listing is the plugin's records (plugin.ts's SessionRecord), one per root session — the
 * host tabs' in their agentDir, the sandboxed tabs' in theirs, read through `sandbox` like any
 * agent's mounted sessions. There is no on-disk format to watch, and `opencode session list` boots a
 * full instance per call (~1.5 s measured, writing to the database) — anomalyco/opencode#37435. Only
 * the one-off actions below pay that.
 *
 * The cost: only sessions run through tet are known, and one removed elsewhere keeps its record
 * until a resume fails.
 */

/** Each repository's or worktree's host agentDir, registered by prepareSpawn (a provider only gets
 *  a cwd). Never cleared. */
const agentDirs = new Map<string, string>();

export function registerAgentDir(cwd: string, agentDir: string): void {
  agentDirs.set(cwd, agentDir);
}

function recordsDir(cwd: string): string | undefined {
  const agentDir = agentDirs.get(cwd);
  return agentDir ? sessionsDir(agentDir) : undefined;
}

/** How long a rename waits for the tab's opencode to apply it. */
const RENAME_TIMEOUT_MS = 5000;
const RENAME_POLL_MS = 250;

async function readRecord(file: string): Promise<SessionRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf8")) as Partial<SessionRecord>;
    // As the plugin names it (plugin.ts's isSessionId), and the file it is in: the id becomes a
    // path in rename and remove, and a sandbox can write these records through its mount.
    if (typeof parsed.id !== "string" || !/^[0-9A-Za-z_-]+$/.test(parsed.id) || `${parsed.id}.json` !== path.basename(file)) {
      return undefined;
    }
    return {
      id: parsed.id,
      title: typeof parsed.title === "string" ? parsed.title : "",
      created: typeof parsed.created === "number" ? parsed.created : 0,
      updated: typeof parsed.updated === "number" ? parsed.updated : 0
    };
  } catch {
    // Not ours, or damaged (never half-written: the plugin renames into place).
    return undefined;
  }
}

async function readRecords(dir: string): Promise<SessionRecord[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readRecord(path.join(dir, name))));
  return records.filter((record): record is SessionRecord => record !== undefined);
}

/** False only when the session is known gone: its sandbox is, or opencode's listing lacks it.
 *  Whatever cannot say counts as there. */
async function sessionListed(executable: string, cwd: string, sandbox: string | null, sessionId: string): Promise<boolean> {
  if (sandbox && (await sandboxExists(sandbox)) === false) {
    return false;
  }
  try {
    const listed = await listOpencodeSessions(executable, cwd, sandbox);
    return listed === undefined || listed.some((session) => session.id === sessionId);
  } catch {
    return true;
  }
}

function listIn(dir: string): Promise<AgentSessionInfo[]> {
  return collectSessions("opencode", async () =>
    (await readRecords(dir)).map((record) => ({
      id: record.id,
      title: record.title,
      updatedAt: record.updated,
      createdAt: record.created
    }))
  );
}

/** `opencode session delete` where the session is: here, or in `sandbox`. The record goes with the
 *  session, or once the session or its sandbox is gone: a removed sandbox took its session with it.
 *  Any other failure keeps it, so a retry still looks where the session is.
 *
 *  An unknown session resolves (SessionProvider.remove). Measured (1.18.4): an unknown id exits 1
 *  like any other failure, so a failed delete asks whether the session is still there
 *  (sessionListed), paying its ~1.5 s only then. */
async function removeIn(executable: string, cwd: string, sandbox: string | null, dir: string | undefined, sessionId: string): Promise<void> {
  try {
    await runOpencode(executable, cwd, sandbox, ["session", "delete", sessionId]);
  } catch (error) {
    if (await sessionListed(executable, cwd, sandbox, sessionId)) {
      throw error;
    }
  }
  if (dir) {
    fs.rmSync(path.join(dir, `${sessionId}.json`), { force: true });
  }
}

/**
 * No `session rename` command, only the HTTP API of the server inside the tab's process. So a
 * request file is left for its plugin (plugin.ts's applyRenames), in the agentDir of the side the
 * session lives on; the rewritten record confirms it. Without a running opencode it is withdrawn
 * after the timeout. anomalyco/opencode#34751 exposed rename via the plugin API, not the CLI —
 * revisit if `session rename <id> <title>` ships.
 */
async function renameIn(agentDir: string, sessionId: string, title: string): Promise<void> {
  const trimmed = requireTitle(title);
  const requests = renameDir(agentDir);
  fs.mkdirSync(requests, { recursive: true });
  const request = path.join(requests, sessionId);
  writeFileAtomic.sync(request, trimmed);
  const recordFile = path.join(sessionsDir(agentDir), `${sessionId}.json`);
  const deadline = Date.now() + RENAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RENAME_POLL_MS));
    if ((await readRecord(recordFile))?.title === trimmed) {
      return;
    }
  }
  fs.rmSync(request, { force: true });
  throw new Error("the session's opencode is not running — start its tab, then rename it");
}

export const opencodeSessionProvider: SessionProvider = {
  // Records only (see the file header).
  list(cwd: string): Promise<AgentSessionInfo[]> {
    const dir = recordsDir(cwd);
    return dir ? listIn(dir) : Promise.resolve([]);
  },

  resumeArgs(sessionId: string): string[] {
    return ["--session", sessionId];
  },

  remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    return removeIn(executable, cwd, null, recordsDir(cwd), sessionId);
  },

  rename(_executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    const agentDir = agentDirs.get(cwd);
    if (!agentDir) {
      return Promise.reject(new Error("opencode has not been prepared for this repository"));
    }
    return renameIn(agentDir, sessionId, title);
  },

  watch(cwd: string, onChange: () => void): () => void {
    const dir = recordsDir(cwd);
    if (!dir) {
      return () => undefined;
    }
    return watchTranscriptDir(
      () => path.dirname(dir),
      () => Promise.resolve(fs.existsSync(dir) ? dir : undefined),
      (filename) => filename.endsWith(".json"),
      onChange
    );
  },

  /** The sandboxed plugin writes its records into its own agentDir (plugin.ts), which the sandbox
   *  mounts whole: `root` is their folder, nothing more to mount. `opencode` itself runs in the
   *  sandbox, so a delete runs there (cli.ts's runOpencode). */
  sandbox: {
    mounts: [],
    list: (root) => listIn(root),
    remove: (root, cwd, sessionId, sandbox) => removeIn("opencode", cwd, sandbox, root, sessionId),
    rename: (root, _cwd, sessionId, title) => renameIn(path.dirname(root), sessionId, title)
  }
};
