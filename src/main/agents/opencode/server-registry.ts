import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The servers tet started, written down so the *next* run can find them again.
 *
 * `opencode serve` owns one SQLite database for the whole machine rather than one per
 * repository, so a server a killed run left behind still writes to the very file this run's
 * servers open, and whoever loses that race dies with "database is locked". Every path that
 * ends the app takes its servers down, but nothing of ours runs when the process is killed —
 * so a previous run's are reclaimed here instead, before the first server of this one starts.
 *
 * Only what this file names is killed, and only once it has answered as one of ours: a pid is
 * not an identity — the number is reused, and by the time it is read the process behind it may
 * be anything at all. The url and the password recorded next to it are what settle that. A
 * server that was killed between being spawned and reporting its url is therefore never
 * recorded and stays behind; there is nothing to recognise it by, and the next start of that
 * repository is what takes it down.
 */
export interface ServerRecord {
  pid: number;
  url: string;
  password: string;
  /** The repository the server was started for — every endpoint is scoped by it, the probe too. */
  cwd: string;
}

/** A server that has not answered by then is not running, and its pid belongs to someone else. */
const PROBE_TIMEOUT_MS = 2000;

let file: string | undefined;
let records: ServerRecord[] = [];
let reclaimed = Promise.resolve();

/** The header opencode's server authenticates with — the registry probes with it, requests carry it. */
export function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

/**
 * Takes down what a previous run left running, and from then on keeps what this one starts.
 * Called once at startup, before any project opens.
 */
export function openServerRegistry(storageRoot: string): void {
  file = path.join(storageRoot, "opencode-servers.json");
  const orphans = read();
  records = [];
  // The file is only cleared once they are gone: killed halfway through this, the run leaves
  // behind a file still naming the servers it did not manage to take down, and the next one
  // tries again.
  reclaimed = killOrphans(orphans).then(write);
}

/** Resolves once the previous run's servers are gone; awaited before starting one. */
export function serversReclaimed(): Promise<void> {
  return reclaimed;
}

export function rememberServer(record: ServerRecord): void {
  records.push(record);
  write();
}

export function forgetServer(pid: number): void {
  records = records.filter((record) => record.pid !== pid);
  write();
}

/** How long a killed server is given to actually go before the reclaim stops waiting for it. */
const KILL_WAIT_MS = 5000;

/**
 * On win32 resolveCommand routes a shim install (`opencode.cmd`) through cmd.exe, and killing
 * the process would only take down that wrapper — verified: the server keeps running, and once
 * its parent is gone it can no longer be reached through the process tree either. So kill the
 * tree instead of the process, while the tree still exists. The npm install on the other two
 * platforms is the same shape — a node launcher in front of the binary — so there the server
 * is spawned into a process group of its own (see `boot`) and the group is what is signalled.
 *
 * Resolves once the process is gone, or the wait is up: the reclaim clears the file on it,
 * and a server still shutting down holds the very database the next one is about to open.
 */
export function killServerTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
        // A child that could not be spawned emits this, and unhandled it takes the process down.
        .on("error", (error) => {
          console.error("[tet] taskkill failed:", error);
          resolve();
        })
        .on("exit", () => resolve());
    });
  }
  try {
    process.kill(-pid);
  } catch {
    // Not a group of its own — a server an older run recorded — or already gone.
    try {
      process.kill(pid);
    } catch {
      return Promise.resolve();
    }
  }
  return waitGone(pid);
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + KILL_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      // Signal 0 sends nothing and only asks whether the pid still exists.
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function killOrphans(orphans: ServerRecord[]): Promise<void> {
  await Promise.all(
    orphans.map(async (orphan) => {
      if (await isOurs(orphan)) {
        await killServerTree(orphan.pid);
      }
    })
  );
}

/**
 * Whether the recorded pid is still the server this file says it is. The password is what makes
 * that an answer rather than a guess: it was generated for that one server and never left this
 * app, so anything replying to it is ours.
 */
async function isOurs(record: ServerRecord): Promise<boolean> {
  try {
    const response = await fetch(`${record.url}/session?directory=${encodeURIComponent(record.cwd)}`, {
      headers: { Authorization: basicAuth(record.password) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    return response.ok;
  } catch {
    // Nothing listening there any more, or something that is not ours.
    return false;
  }
}

/** Read defensively like every file tet writes: half of it being someone else's is no reason to throw. */
function read(): ServerRecord[] {
  if (!file) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    // No file yet (first start), or unreadable — nothing to reclaim.
    return [];
  }
}

function isRecord(entry: unknown): entry is ServerRecord {
  const record = entry as ServerRecord | null;
  return (
    typeof record === "object" &&
    record !== null &&
    typeof record.pid === "number" &&
    typeof record.url === "string" &&
    typeof record.password === "string" &&
    typeof record.cwd === "string"
  );
}

function write(): void {
  if (!file) {
    return;
  }
  try {
    fs.writeFileSync(file, JSON.stringify(records, null, 2), "utf8");
  } catch (error) {
    console.error("[tet] could not persist the opencode server list:", error);
  }
}
