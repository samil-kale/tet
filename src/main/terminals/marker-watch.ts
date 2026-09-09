import * as fs from "node:fs";
import * as path from "node:path";
import type { HookTarget } from "./hook-target";
import { powershellSingleQuote, shellSingleQuote, WIN_BOM, writePosixScript } from "./os-notify";

/** The kinds of marker a hook drops and tet watches for: `busy` and `finished` for either end of a
 *  turn, `waiting` for one stopped part-way on a question. A marker's *filename* is the whole
 *  message, so a reader never races a half-written file. */
export type Marker = "busy" | "finished" | "waiting";

/** How often the marker directories are swept regardless of the watcher. */
const MARKER_SWEEP_MS = 2000;

/** The characters a session id may consist of — uuids or hex for Claude Code, Codex and pi, `ses_`
 *  plus base62 for opencode — and so the only ones that may reach a marker's filename: no
 *  separator, no dot, nothing that could leave the directory. Also in the generated pi extension
 *  and opencode plugin. */
export const SESSION_ID_CHARS = "0-9A-Za-z_-";

export function markerDir(storageDir: string, kind: Marker): string {
  return path.join(storageDir, kind);
}

/** The lines that turn a hook payload's session id into a marker file, in each shell, shared by
 *  every hook of every agent. `$json` must be in scope, holding the parsed payload (win32) or its
 *  raw text (sh). */
export function markPowershell(dir: string): string {
  return `  # Matched before use as a path: nothing but a session id may become a filename here.
  # -Force so a session reaching this twice overwrites its own empty marker rather than erroring.
  $id = [string]$json.session_id
  if ($id -match '^[${SESSION_ID_CHARS}]+$') {
    New-Item -ItemType File -Force -Path (Join-Path ${powershellSingleQuote(dir)} $id) -ErrorAction SilentlyContinue | Out-Null
  }`;
}

export function markPosix(dir: string): string {
  return `# Only the session-id characters are captured, so nothing else becomes a filename below.
id=$(printf '%s' "$json" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([${SESSION_ID_CHARS}]*\\)".*/\\1/p')
# touch rather than a ">" redirection: ":" is a special built-in, and POSIX has a failed
# redirection on one of those end the whole shell, the one time the directory is missing.
if [ -n "$id" ]; then
  touch ${shellSingleQuote(dir)}/"$id" 2>/dev/null || true
fi`;
}

/**
 * The hook command shared by every marker hook without a guard of its own: read the JSON payload
 * off stdin, touch a file named after its session id in the `kind` directory, then run
 * `notifyCommand` if one was given. Always exits 0: a failing UserPromptSubmit hook can hold the
 * prompt back. Where `stdout` is supplied, the notification's result is hidden so that value is
 * the script's complete output. `id` names the script file, which two hooks must not share.
 */
export function buildMarkCommand(
  storageDir: string,
  id: string,
  kind: Marker,
  notifyCommand: string | undefined,
  target: HookTarget,
  stdout?: string
): string {
  const marks = markerDir(storageDir, kind);
  fs.mkdirSync(marks, { recursive: true });
  if (!target.posix) {
    const scriptFile = path.join(storageDir, `${id}.ps1`);
    const notify = notifyCommand ? `${notifyCommand}${stdout === undefined ? "" : " | Out-Null"}` : "";
    const output = stdout === undefined ? "" : `[Console]::Out.WriteLine(${powershellSingleQuote(stdout)})`;
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
${markPowershell(target.embed(marks))}
} catch {}
${notify}
${output}
exit 0
`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${target.embed(scriptFile)}"`;
  }
  const scriptFile = path.join(storageDir, `${id}.sh`);
  const notify = notifyCommand ? `${notifyCommand}${stdout === undefined ? "" : " >/dev/null"}` : "";
  const output = stdout === undefined ? "" : `printf '%s\\n' ${shellSingleQuote(stdout)}`;
  writePosixScript(
    scriptFile,
    `#!/bin/sh
json=$(cat)
${markPosix(target.embed(marks))}
${notify}
${output}
exit 0
`
  );
  return `sh "${target.embed(scriptFile)}"`;
}

/** The prompt-submitted hook's command: marks the session busy, the other end of the turn from
 *  the agent's Stop hook. No guard of its own, and shared by every marker agent. */
export function buildBusyCommand(storageDir: string, target: HookTarget): string {
  return buildMarkCommand(storageDir, "busy", "busy", undefined, target);
}

/**
 * An approval/question hook's command: marks the session waiting on the user, then notifies where
 * notifications are on. The marker puts the mark on the tab regardless of the settings; only the
 * toast is optional. `waiting` says where the turn stopped, not that it ended. Every agent
 * registers it twice — a permission prompt and a question tool, wanting different wording — so
 * `id` names the script file.
 */
export function buildWaitingCommand(
  storageDir: string,
  id: string,
  notifyCommand: string | undefined,
  target: HookTarget
): string {
  return buildMarkCommand(storageDir, id, "waiting", notifyCommand, target);
}

/** The tet half of a hook-driven agent's markers: reports every session marked with `kind` and
 *  takes the marker away again, the state living in the tab from then on. Whatever is already
 *  there at startup is deleted *without* being reported. */
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
      // The hook has never run here, or its setup failed.
      return;
    }
    for (const name of names) {
      let at: number;
      try {
        const file = path.join(dir, name);
        // The write time travels with the report: the kinds are swept separately, so a `busy` the
        // watcher missed can be found *after* the `finished` of the same short turn.
        at = (await fs.promises.stat(file)).mtimeMs;
        // Not `force`: an unlink that did not happen is not a turn to report.
        await fs.promises.unlink(file);
      } catch {
        continue;
      }
      if (report && !stopped) {
        onMarker(name, at);
      }
    }
  };

  // One drain at a time, in order: the startup drain's own unlinks fire the watcher, and a drain
  // started by that would race it for the next stale marker.
  let draining = Promise.resolve();
  const queueDrain = (report: boolean): void => {
    draining = draining.then(() => drain(report)).catch(() => undefined);
  };
  queueDrain(false);
  let watcher: fs.FSWatcher | undefined;
  try {
    // The hooks that create `dir` only run for a tab that actually starts, while watchTurnMarkers
    // is called unconditionally from every prepareSpawn. Idempotent.
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, () => queueDrain(true));
    // Unhandled, an `error` (the directory removed underneath it, on win32) takes the main
    // process down; the sweep below carries on without the watcher.
    watcher.on("error", (error) => console.error(`[tet] ${kind} marker watcher failed in ${dir}:`, error));
  } catch (error) {
    console.error(`[tet] could not watch ${kind} markers in ${dir}:`, error);
  }
  // The sweep is the net under the watcher, measured: on win32 fs.watch can fire before the new
  // name is in the directory listing and never fires again, so one lost event strands a turn
  // forever — a marker sat in `finished/` for minutes until the next write drained it too.
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

/** All three kinds at once, for an agent whose hooks are processes of their own. One stop for all. */
export function watchTurnMarkers(storageDir: string, reporter: TurnReporter): () => void {
  const stops = [
    watchMarkers(storageDir, "busy", reporter.onSessionBusy),
    watchMarkers(storageDir, "finished", reporter.onSessionFinished),
    watchMarkers(storageDir, "waiting", reporter.onSessionWaiting)
  ];
  return () => stops.forEach((stop) => stop());
}
