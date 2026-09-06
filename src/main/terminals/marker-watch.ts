import * as fs from "node:fs";
import * as path from "node:path";
import { powershellSingleQuote, shellSingleQuote, WIN_BOM, writePosixScript } from "./os-notify";

/**
 * Where a hook drops its markers, and where tet watches for them, shared by every agent
 * whose lifecycle signals arrive as hook-written files rather than an event stream: three kinds,
 * `busy` from a prompt-submitted hook and `finished` from a turn-ended hook, either end of a
 * turn, plus `waiting` from an approval/question hook for a turn that stopped part-way on a
 * question. A marker's *filename* is the whole message — nothing is read out of a file, so a
 * reader never races a half-written one, which every other file shared with another process here
 * has to be written around.
 */
export type Marker = "busy" | "finished" | "waiting";

/**
 * How often the marker directories are swept regardless of the watcher — see watchMarkers for
 * what this is a net under. Two seconds: a spinner that stops a moment late reads as the agent
 * finishing, while one that never stops reads as a broken app.
 */
const MARKER_SWEEP_MS = 2000;

/**
 * The characters a session id may consist of — every agent's ids are uuids or hex — and so
 * the only ones that may ever reach a marker's filename. Written once here, spelled into each
 * guard below and into pi's generated extension, so nothing but a session id becomes a path.
 */
export const SESSION_ID_CHARS = "0-9a-fA-F-";

export function markerDir(storageDir: string, kind: Marker): string {
  return path.join(storageDir, kind);
}

/**
 * The lines that turn a hook payload's session id into a marker file, in each shell. Written
 * once for every hook of every agent, so the one thing that has to be exactly right — that
 * nothing but a session id can ever become a filename — is written once. `$json` must be in
 * scope, holding the parsed payload (win32) or its raw text (sh).
 */
export function markPowershell(dir: string): string {
  return `  # Matched before it is used as a path: the id is a uuid and nothing else may become
  # a filename here. -Force so a session that reaches this twice overwrites its own marker
  # rather than erroring - the file is empty, there is nothing in it to lose.
  $id = [string]$json.session_id
  if ($id -match '^[${SESSION_ID_CHARS}]+$') {
    New-Item -ItemType File -Force -Path (Join-Path ${powershellSingleQuote(dir)} $id) -ErrorAction SilentlyContinue | Out-Null
  }`;
}

export function markPosix(dir: string): string {
  return `# Only the uuid characters are captured, so nothing else can ever become a filename below.
id=$(printf '%s' "$json" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([${SESSION_ID_CHARS}]*\\)".*/\\1/p')
# touch rather than a ">" redirection: ":" is a special built-in, and POSIX has a failed
# redirection on one of those end the whole shell - which would take whatever follows with it
# the one time the directory is missing.
if [ -n "$id" ]; then
  touch ${shellSingleQuote(dir)}/"$id" 2>/dev/null || true
fi`;
}

/**
 * The hook command shared by every marker hook without a guard of its own: read the JSON
 * payload off stdin, touch a file named after its session id in the `kind` directory, then run
 * `notifyCommand` if one was given. Always exits 0 — a hook on UserPromptSubmit that fails can
 * hold the prompt back, and none of these has anything to report by exit code. `id` names the
 * script file, since two hooks of one agent must not share one.
 */
export function buildMarkCommand(storageDir: string, id: string, kind: Marker, notifyCommand: string | undefined): string {
  const marks = markerDir(storageDir, kind);
  fs.mkdirSync(marks, { recursive: true });
  if (process.platform === "win32") {
    const scriptFile = path.join(storageDir, `${id}.ps1`);
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
${markPowershell(marks)}
} catch {}
${notifyCommand ?? ""}
exit 0
`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
  }
  const scriptFile = path.join(storageDir, `${id}.sh`);
  writePosixScript(
    scriptFile,
    `#!/bin/sh
json=$(cat)
${markPosix(marks)}
${notifyCommand ?? ""}
exit 0
`
  );
  return `sh "${scriptFile}"`;
}

/**
 * The prompt-submitted hook's command: marks the session busy, the other end of the turn from
 * the agent's Stop hook. No guard of its own — a prompt was submitted, so the agent is busy,
 * full stop. Shared by every marker agent: what differs between them is the Stop end (Claude
 * Code's `background_tasks` guard), never this one.
 */
export function buildBusyCommand(storageDir: string): string {
  return buildMarkCommand(storageDir, "busy", "busy", undefined);
}

/**
 * An approval/question hook's command: marks the session waiting on the user, then notifies
 * where notifications are on. The marker is what puts the mark on the tab, and that mark is not
 * a notification the user can turn off — it is how a session blocked out of sight is found
 * again; only the toast is optional. It carries no turn state: the turn is still open, and
 * `waiting` says where it stopped, not that it ended.
 *
 * Every agent registers it twice — once for a permission prompt, once for a question tool — so
 * `id` names the script file: the two callers want different toast wording, and a shared file
 * would have the second overwrite the first.
 */
export function buildWaitingCommand(storageDir: string, id: string, notifyCommand: string | undefined): string {
  return buildMarkCommand(storageDir, id, "waiting", notifyCommand);
}

/**
 * The tet half of a hook-driven agent's markers: reports every session marked with `kind`
 * and takes the marker away again. From then on the state lives in the tab, so a file left lying
 * around would report the same turn again on the next start.
 *
 * Whatever is already in there at startup is therefore deleted *without* being reported: those
 * turns ended before this window existed, and every tab is freshly opened at that point.
 */
export function watchMarkers(
  storageDir: string,
  kind: Marker,
  /** `at` is the marker's mtime — when the hook wrote it, not when it was found. */
  onMarker: (sessionId: string, at: number) => void
): () => void {
  const dir = markerDir(storageDir, kind);
  let stopped = false;

  const drain = async (report: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      // The hook has never run here, or its setup failed — nothing to report either way.
      return;
    }
    for (const name of names) {
      let at: number;
      try {
        const file = path.join(dir, name);
        // The time it was written travels with the report: the three kinds are watched and
        // swept separately, so a `busy` the watcher missed can be found *after* the `finished`
        // of the same short turn, and the reader needs to know which came first.
        at = (await fs.promises.stat(file)).mtimeMs;
        // Not `force`: a marker gone by now raises ENOENT here, and an unlink that did not
        // happen is not a turn to report.
        await fs.promises.unlink(file);
      } catch {
        continue;
      }
      if (report && !stopped) {
        onMarker(name, at);
      }
    }
  };

  // One drain at a time, in order: the startup drain's own unlinks fire the watcher, and a
  // drain started by that would race it for the next stale marker — and report it.
  let draining = Promise.resolve();
  const queueDrain = (report: boolean): void => {
    draining = draining.then(() => drain(report)).catch(() => undefined);
  };
  queueDrain(false);
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, () => queueDrain(true));
    // Unhandled, an `error` (the directory removed underneath it, on win32) takes the main
    // process down; the sweep below carries on without the watcher.
    watcher.on("error", (error) => console.error(`[tet] ${kind} marker watcher failed in ${dir}:`, error));
  } catch (error) {
    console.error(`[tet] could not watch ${kind} markers in ${dir}:`, error);
  }
  // The watcher alone is not enough, and this was measured rather than feared: a marker sat in
  // `finished/` for minutes while the process that should have picked it up was running
  // and healthy — the next write drained it along with the fresh one. On win32 fs.watch can
  // fire before the new name is in the directory listing, and nothing fires a second time, so
  // one lost event strands a turn *forever*: the spinner never stops and the mark never lands.
  // A readdir on an all-but-always-empty directory is a syscall, not a process, so the net
  // costs nothing; the watcher stays because it is what makes the common case immediate.
  const sweep = setInterval(() => queueDrain(true), MARKER_SWEEP_MS);
  return () => {
    stopped = true;
    clearInterval(sweep);
    watcher?.close();
  };
}

/** What a turn's three markers report into — the agent's callbacks on `AgentPaths`. */
export interface TurnReporter {
  onSessionBusy: (sessionId: string, at: number) => void;
  onSessionFinished: (sessionId: string, at: number) => void;
  onSessionWaiting: (sessionId: string, at: number) => void;
}

/**
 * All three kinds at once, for an agent whose hooks are processes of their own and cannot call
 * back into tet: each end of a turn — and the point part-way through where it stops for an
 * answer — leaves a file behind, and this is what picks them up. Returns the one stop for all.
 */
export function watchTurnMarkers(storageDir: string, reporter: TurnReporter): () => void {
  const stops = [
    watchMarkers(storageDir, "busy", reporter.onSessionBusy),
    watchMarkers(storageDir, "finished", reporter.onSessionFinished),
    watchMarkers(storageDir, "waiting", reporter.onSessionWaiting)
  ];
  return () => stops.forEach((stop) => stop());
}
