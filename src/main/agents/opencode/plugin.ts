import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { markerDir, SESSION_ID_CHARS } from "../../terminals/marker-watch";
import type { HookTarget } from "../../terminals/hook-target";
import type { NotificationSettings } from "../../../shared/types";

/**
 * opencode is driven through one generated plugin per repository, the way pi is driven through
 * a generated extension: a `.ts` file under a config directory's `plugins/`, loaded in-process
 * by the `opencode` the tab runs. It has no declarative hook file, and the plugin API is the
 * one way into a message being composed (`chat.message`) — and, since it also delivers the
 * server's whole event bus (`event`), the one place every turn signal can be read without a
 * server of tet's own to subscribe to. Measured against 1.18.4 on the host and 1.18.23 in an
 * sbx sandbox (2026-09-08): the plugin loads in the TUI (where opencode's server is a worker
 * thread of the same process) and in `run`, and the `event` hook receives `session.created`,
 * `session.updated` (with the whole session), `session.status`, `session.idle`,
 * `permission.asked`/`replied` and `question.asked` exactly as the `/event` stream does.
 *
 * `OPENCODE_CONFIG_DIR` points opencode at the directory additively: it does not replace the
 * user's `.opencode/plugins/` or `~/.config/opencode/plugins/`. The first time opencode sees a
 * `plugins/` file in a config dir it bun-installs `@opencode-ai/plugin` *into that dir*
 * (`node_modules/`, measured), which takes seconds to minutes — so the host's dir is shared
 * across repositories to pay that once per machine, and a sandbox gets a dir of its own
 * under agentDir (a Linux install, never the host's).
 */

/** The three session markers plus the two files a session leaves for tet — see the header. */
export interface OpencodePluginOptions {
  /** The repository's root as the plugin's own process sees it — the `TET_PROJECT_ROOT` guard. */
  projectRoot: string;
  contextFile: string;
  markers: { busy: string; finished: string; waiting: string };
  /** Where a session record goes (sessions/<id>.json) and where a rename request is found. */
  sessionsDir: string;
  renameDir: string;
  /** The sbx sandbox this plugin runs in, recorded on every session; null on the host. */
  sandbox: string | null;
  /** Whether to toast at either end, from the notification settings. */
  notify: { finished: boolean; waiting: boolean };
  /** How the plugin's process starts `tet-ctl notify` — see notifyInvocation. */
  notifyCommand: { command: string; args: string[] };
  displayName: string;
  repositoryName: string;
}

/** Set on the tab's process so the generated plugin can tell whose repository it is serving. */
export const PROJECT_ROOT_ENV = "TET_PROJECT_ROOT";

/** The record one session leaves under sessionsDir — what the listing reads. */
export interface SessionRecord {
  id: string;
  title: string;
  created: number;
  updated: number;
  sandbox: string | null;
}

/**
 * Where a sandboxed tab's plugin lives: its own config dir under agentDir, mounted into the
 * sandbox whole, so its bun install is a Linux one and never collides with the host's.
 */
export function sandboxConfigDir(agentDir: string): string {
  return path.join(agentDir, "sandbox", "opencode");
}

export function sessionsDir(agentDir: string): string {
  return path.join(agentDir, "sessions");
}

export function renameDir(agentDir: string): string {
  return path.join(agentDir, "rename");
}

/**
 * The toast is `tet-ctl notify`, host and sandbox alike (see os-notify.ts's
 * buildHookNotifyCommand for why), started from inside opencode's process as a plain spawn: on
 * a POSIX target the launcher is a script found on PATH, on a win32 host a `.cmd` that only
 * cmd.exe can start — the arguments are passed to it as a list, never spliced into a line.
 */
function notifyInvocation(target: HookTarget): { command: string; args: string[] } {
  return target.posix ? { command: "tet-ctl", args: ["notify"] } : { command: "cmd.exe", args: ["/c", "tet-ctl", "notify"] };
}

/** The plugin's filename in a shared plugins dir: unique per repository. */
function pluginName(cwd: string): string {
  return `tet-${crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.ts`;
}

/**
 * Writes this repository's plugin into `configDir/plugins/` for one target and returns the
 * environment that makes opencode load and scope it. The marker and record directories are
 * created here: watchMarkers wants them to exist to fs.watch them. Written beside the target and
 * renamed into place, and only when the content changed — opencode recompiles a plugin whose
 * file changed, at a cost of seconds to minutes, so a restart of tet must not retrigger that.
 */
export function writeOpencodePlugin(
  configDir: string,
  agentDir: string,
  cwd: string,
  displayName: string,
  notifications: NotificationSettings,
  contextFile: string,
  target: HookTarget,
  sandbox: string | null
): Record<string, string> {
  const pluginsDir = path.join(configDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  const markers = { busy: markerDir(agentDir, "busy"), finished: markerDir(agentDir, "finished"), waiting: markerDir(agentDir, "waiting") };
  for (const dir of [...Object.values(markers), sessionsDir(agentDir), renameDir(agentDir)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const contents = renderOpencodePlugin({
    projectRoot: target.embed(cwd),
    contextFile: target.embed(contextFile),
    markers: { busy: target.embed(markers.busy), finished: target.embed(markers.finished), waiting: target.embed(markers.waiting) },
    sessionsDir: target.embed(sessionsDir(agentDir)),
    renameDir: target.embed(renameDir(agentDir)),
    sandbox,
    notify: { finished: notifications.finished, waiting: notifications.needsYou },
    notifyCommand: notifyInvocation(target),
    displayName,
    repositoryName: path.basename(cwd)
  });
  const file = path.join(pluginsDir, pluginName(cwd));
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== contents) {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, contents);
    fs.renameSync(temp, file);
  }
  // The generation before this one wrote `context-<hash>.ts` into the same shared dir; left
  // there, it would load alongside and append the context a second time.
  const stale = path.join(pluginsDir, `context-${pluginName(cwd).slice("tet-".length)}`);
  fs.rmSync(stale, { force: true });
  return { OPENCODE_CONFIG_DIR: target.embed(configDir), [PROJECT_ROOT_ENV]: target.embed(cwd) };
}

/**
 * The plugin's TypeScript source, pure so the test can compile and drive it without opencode.
 * Nothing is imported from opencode's packages: the file has to be valid wherever the config
 * dir is, and the event contract is plain objects. Every path and name is baked in as a JSON
 * literal, never spliced raw.
 */
export function renderOpencodePlugin(options: OpencodePluginOptions): string {
  return `// Generated by tet for one repository — rewritten whenever this project's opencode is
// prepared, and read by nothing but opencode. Marker files under the three directories are how
// tet learns about this session's turns (marker-watch.ts); the session records are its listing;
// the context file is tet's, kept current for the model.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PROJECT_ROOT = ${JSON.stringify(options.projectRoot)};
const CONTEXT_FILE = ${JSON.stringify(options.contextFile)};
const MARKERS = ${JSON.stringify(options.markers)};
const SESSIONS_DIR = ${JSON.stringify(options.sessionsDir)};
const RENAME_DIR = ${JSON.stringify(options.renameDir)};
const SANDBOX: string | null = ${JSON.stringify(options.sandbox)};
const NOTIFY = ${JSON.stringify(options.notify)};
const NOTIFY_COMMAND = ${JSON.stringify(options.notifyCommand)};
const TITLES = ${JSON.stringify({
    finished: [`${options.displayName}: Finished`, `Finished in ${options.repositoryName}`],
    waiting: [`${options.displayName}: Action needed`, `Waiting for input in ${options.repositoryName}`]
  })};
// A permission opencode approves by itself still raises permission.asked, with the reply
// milliseconds behind it (measured: 7 ms). Held this long before it counts as a question, and
// let go when the reply arrives first.
const PERMISSION_SETTLE_MS = 500;
// How often a rename request left by tet is looked for. Polled, not watched: an inotify watch
// sees nothing written from the other side of a Docker bind mount.
const RENAME_POLL_MS = 1000;
const WAITING_TOAST_GAP_MS = 2000;

// The marker's filename is the whole message, so only a session id may ever become one — the
// same guard the shell hooks apply, from the same list of characters. Rewriting an existing
// marker is harmless: the file is empty, and its mtime is what tet reads as the time.
function isSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[${SESSION_ID_CHARS}]+$/.test(id);
}

// What ties a permission's reply to its request: the request's own id, which the reply has
// carried under three names across releases (opencode-notify and wmux read the same three).
function permissionKey(props: any): string {
  return [props.id, props.requestID, props.permissionID].find((value) => typeof value === "string") ?? String(props.sessionID);
}

function mark(dir: string, id: unknown): void {
  if (!isSessionId(id)) {
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id), "");
  } catch {
    // Nothing to tell opencode about; a missed mark is a tab that has to be looked at.
  }
}

// Written beside the target and renamed into place: tet reads these from another process, and
// on Windows a read landing mid-write fails outright.
function writeRecord(id: string, record: unknown): void {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const file = path.join(SESSIONS_DIR, id + ".json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(record));
    fs.renameSync(file + ".tmp", file);
  } catch {
    // As above.
  }
}

// A plain spawn with stdio ignored, the way pi's extension does it (measured there: detached
// plus unref never ran at all). Never awaited: opencode waits for a hook to return, and a toast
// must not hold up the TUI's own idle transition.
function notify(kind: "finished" | "waiting"): void {
  if (!NOTIFY[kind]) {
    return;
  }
  try {
    spawn(NOTIFY_COMMAND.command, [...NOTIFY_COMMAND.args, ...TITLES[kind]], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
  } catch {
    // As above.
  }
}

export const TETPlugin = async (input: any) => {
  // The host's plugins dir is shared across repositories, so each repository's process loads
  // every repository's plugin; the variable is set on the process, and without this guard a
  // message would get every other open repository's context appended too.
  const mine = process.env.${PROJECT_ROOT_ENV} === PROJECT_ROOT;
  // Subagent sessions (opencode's task tool) go idle on every turn of theirs and raise
  // questions of their own; the tab is about the root session, so a child's signals are
  // dropped — like Claude Code's background_tasks guard. Children are created in this very
  // process, so their created/updated event is seen before any signal of theirs; an id never
  // seen is treated as a root, since a spurious mark beats a missed one.
  const children = new Set<string>();
  const pendingPermissions = new Map<string, ReturnType<typeof setTimeout>>();
  // One question reaches this twice — question.asked and the tool call below, milliseconds
  // apart (measured) — and a permission can follow a question within the same turn. The
  // marker absorbs a repeat; the toast is held back for a moment per session.
  const lastWaitingToast = new Map<string, number>();

  const waiting = (sessionId: unknown): void => {
    if (!isSessionId(sessionId) || children.has(sessionId)) {
      return;
    }
    mark(MARKERS.waiting, sessionId);
    const now = Date.now();
    if (now - (lastWaitingToast.get(sessionId) ?? 0) > WAITING_TOAST_GAP_MS) {
      lastWaitingToast.set(sessionId, now);
      notify("waiting");
    }
  };

  const onSession = (info: any, deleted: boolean): void => {
    if (!info || !isSessionId(info.id)) {
      return;
    }
    if (typeof info.parentID === "string" && info.parentID.length > 0) {
      children.add(info.id);
      return;
    }
    if (deleted) {
      try {
        fs.rmSync(path.join(SESSIONS_DIR, info.id + ".json"), { force: true });
      } catch {
        // Gone already, or never written.
      }
      return;
    }
    writeRecord(info.id, {
      id: info.id,
      title: typeof info.title === "string" ? info.title : "",
      created: typeof info.time?.created === "number" ? info.time.created : 0,
      updated: typeof info.time?.updated === "number" ? info.time.updated : 0,
      sandbox: SANDBOX
    });
  };

  // A rename tet asked for: a file named after the session, holding the new title. Applied
  // through the server this process already is — opencode's own session.updated then rewrites
  // the record, which is how tet learns it landed.
  const applyRenames = async (): Promise<void> => {
    let names: string[];
    try {
      names = fs.readdirSync(RENAME_DIR);
    } catch {
      return;
    }
    for (const id of names) {
      if (!isSessionId(id)) {
        continue;
      }
      const file = path.join(RENAME_DIR, id);
      let title: string;
      try {
        title = fs.readFileSync(file, "utf8").trim();
      } catch {
        continue;
      }
      try {
        if (title) {
          await input.client.session.update({ path: { id }, body: { title } });
        }
      } catch {
        // The session is not this process's to rename; tet's own timeout says so.
      }
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Picked up again next time, and the update above is idempotent.
      }
    }
  };
  if (mine) {
    setInterval(() => void applyRenames(), RENAME_POLL_MS).unref();
  }

  return {
    "chat.message": async (_input: any, output: any) => {
      if (!mine) return;
      try {
        let text = fs.readFileSync(CONTEXT_FILE, "utf8");
        if (text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }
        if (text.trim().length > 0) {
          output.parts.push({
            id: "prt_" + randomUUID().replace(/-/g, ""),
            sessionID: output.message.sessionID,
            messageID: output.message.id,
            type: "text",
            text,
            synthetic: true
          });
        }
      } catch {
        // Nothing run in a shell yet — skip silently.
      }
    },
    // The question tool raises question.asked below as well; seen here too, the way
    // opencode-notify does it, in case the event is renamed out from under us.
    "tool.execute.before": async (call: any) => {
      if (mine && call?.tool === "question") {
        waiting(call.sessionID);
      }
    },
    event: async ({ event }: { event: any }) => {
      if (!mine || !event || typeof event.type !== "string") {
        return;
      }
      const props = event.properties ?? {};
      switch (event.type) {
        case "session.created":
        case "session.updated":
          onSession(props.info, false);
          return;
        case "session.deleted":
          onSession(props.info, true);
          return;
        // Raised for every step of a turn — a retry, the next model call — and the marker is
        // simply rewritten. The other statuses (idle, retry) are not a start.
        case "session.status":
          if (props.status?.type === "busy" && !children.has(props.sessionID)) {
            mark(MARKERS.busy, props.sessionID);
          }
          return;
        // The end of the turn as the tab sees it — also after an error and after an abort
        // (measured), and sometimes twice for one turn, which the marker absorbs.
        case "session.idle":
          if (isSessionId(props.sessionID) && !children.has(props.sessionID)) {
            mark(MARKERS.finished, props.sessionID);
            notify("finished");
          }
          return;
        case "permission.asked": {
          const key = permissionKey(props);
          if (pendingPermissions.has(key)) {
            return;
          }
          const timer = setTimeout(() => {
            pendingPermissions.delete(key);
            waiting(props.sessionID);
          }, PERMISSION_SETTLE_MS);
          timer.unref?.();
          pendingPermissions.set(key, timer);
          return;
        }
        case "permission.replied": {
          const key = permissionKey(props);
          const timer = pendingPermissions.get(key);
          if (timer) {
            clearTimeout(timer);
            pendingPermissions.delete(key);
          }
          return;
        }
        case "question.asked":
          waiting(props.sessionID);
          return;
        default:
          return;
      }
    }
  };
};
`;
}
