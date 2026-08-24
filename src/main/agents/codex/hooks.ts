import * as crypto from "node:crypto";
import { buildMarkCommand } from "../../terminals/marker-watch";
import { buildNotifyCommand, buildReadFileCommand } from "../../terminals/os-notify";
import type { NotificationSettings } from "../../../shared/types";

/**
 * Codex only runs a hook once it is *trusted* — a sha256 over a normalized form of its event
 * name, matcher and command, checked against a `trusted_hash` Codex reads back out of its own
 * config. Passed cold, an unknown hash means an interactive session opens on a blocking "Hooks
 * need review" screen instead of the chat. Reproduced here so tet can hand in the matching
 * hash alongside the hook itself and skip that screen entirely — verified end to end against a
 * real Codex install (five (event, matcher, command) → hash pairs Codex itself computed, and a
 * live interactive session that went straight to the chat with a never-before-seen hash set).
 *
 * `timeout` is always present at its effective value: 600 is the default for every event Codex
 * lets a hook run on other than SessionEnd (tet uses none of the events that differ), so it
 * has to be in the hash even though tet never sets it explicitly. Key order matters — this
 * has to be a real recursive alphabetical sort, not the object's own key order (`matcher`, when
 * present, sorts after `hooks`, not between `event_name` and `hooks`).
 *
 * `async` stays `false`: Codex's own schema has it, but the installed build refuses an `async`
 * hook outright ("async hooks are not supported yet") rather than merely warning, dropping it
 * from the trust listing entirely — confirmed by testing, not by reading the schema. Revisit
 * once a Codex release actually runs one.
 *
 * If Codex ever changes this normalization, the pre-computed hash simply stops matching: the
 * hook shows as "Modified" instead of "Trusted" and the review screen reappears once, the same
 * as it would for a user who hand-edited their own config — not a crash, not a silent failure.
 * Cross-check against `hooks/src/engine/discovery.rs::hook_hash` and `config/src/fingerprint.rs`
 * in the Codex source if it ever does.
 */
export function hookTrustedHash(eventLabel: string, command: string, matcher?: string): string {
  const identity: Record<string, unknown> = { event_name: eventLabel };
  if (matcher !== undefined) {
    identity.matcher = matcher;
  }
  identity.hooks = [{ async: false, command, timeout: 600, type: "command" }];
  const canonical = JSON.stringify(sortKeysDeep(identity));
  return `sha256:${crypto.createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The synthetic config path Codex assigns hooks passed on the command line — always this literal
 * string on win32 (`/<session-flags>/config.toml` elsewhere), whichever repository is asking.
 * Not a real file: it exists only to give `-c`-supplied hooks a trust key, the same shape a real
 * config file's path would have.
 */
const SESSION_FLAGS_SOURCE =
  process.platform === "win32" ? String.raw`C:\<session-flags>\config.toml` : "/<session-flags>/config.toml";

/**
 * Codex's snake_case label for a hook event, as it appears in a trust key. `handlerIndex` is the
 * handler's own position within the event's one matcher group (`group_index` is always `0` here
 * — tet never registers two matcher groups for the same event) — each handler is trusted
 * *independently*, hashed as if it were the only one in its group, verified against Codex's own
 * `hooks/list` for a two-handler `UserPromptSubmit` (context file, then the busy marker): the
 * second handler's key is `…:0:1`, not folded into the first's hash.
 */
function trustKey(eventLabel: string, handlerIndex: number): string {
  return `${SESSION_FLAGS_SOURCE}:${eventLabel}:0:${handlerIndex}`;
}

/**
 * TOML literal string (`'...'`): everything but `'` itself is taken verbatim, so a Windows path
 * full of backslashes and a PowerShell command line full of `"` need no escaping at all — the
 * same reasoning `powershellSingleQuote`/`shellSingleQuote` apply to their own shells. None of
 * what tet generates (its own storage paths, a sha256 hash, `request_user_input`) can ever
 * contain a `'`, but a Windows user or repository name could, so this still has to fall back
 * rather than emit invalid TOML — a basic string, with `\` and `"` escaped this time since those
 * *do* mean something inside one.
 */
function tomlValue(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface HookEntry {
  /** Codex's PascalCase event name, as it appears in `config.toml`. */
  event: string;
  /** The same event, Codex's snake_case label, as it appears in a trust key. */
  label: string;
  /** In registration order — `UserPromptSubmit` has two (read the context, then mark busy). */
  commands: string[];
  /** Only `PreToolUse` is given one here; every other event either ignores or doesn't need it. */
  matcher?: string;
}

/**
 * The one `-c hooks={…}` argument covering every hook tet registers and its matching trust
 * entry, built as a single TOML value on purpose: `-c hooks.Stop=[…]` and a second
 * `-c hooks.state…=…` do not reliably merge (verified — the state entry silently failed to
 * apply), and `-c`'s own key-path parsing splits on every literal `.` in the *key* before any
 * TOML parsing runs, which corrupts a trust key that itself contains one (`config.toml`). Putting
 * everything inside the *value* of one `-c hooks=…` sidesteps both: a real TOML parser handles
 * the quoted trust key correctly, and there is nothing left to merge.
 */
function buildHooksArg(entries: HookEntry[]): string {
  const hookGroups = entries
    .map((entry) => {
      const matcherPart = entry.matcher !== undefined ? `matcher=${tomlValue(entry.matcher)},` : "";
      const handlers = entry.commands.map((command) => `{type='command',command=${tomlValue(command)}}`).join(",");
      return `${entry.event}=[{${matcherPart}hooks=[${handlers}]}]`;
    })
    .join(",");
  const stateEntries = entries
    .flatMap((entry) =>
      entry.commands.map((command, handlerIndex) => {
        const hash = hookTrustedHash(entry.label, command, entry.matcher);
        return `${tomlValue(trustKey(entry.label, handlerIndex))}={trusted_hash=${tomlValue(hash)}}`;
      })
    )
    .join(",");
  return `hooks={${hookGroups},state={${stateEntries}}}`;
}

/**
 * Builds the command line for the UserPromptSubmit hook: marks the session busy, the other end
 * of the turn from Stop below. No guard of its own — a prompt was submitted, so the agent is
 * busy, full stop.
 */
function buildBusyCommand(storageDir: string): string {
  return buildMarkCommand(storageDir, "busy", "busy", undefined);
}

/**
 * Builds the Stop hook's command line: marks the session finished, then notifies where
 * notifications are on. Unlike Claude Code, Codex has no `background_tasks` payload to guard
 * against — a turn that merely spawns a subagent and returns is reported through the separate
 * `SubagentStop` event, which tet does not hook, so Stop firing always means this turn is
 * actually over.
 */
function buildStopCommand(storageDir: string, notifyCommand: string | undefined): string {
  return buildMarkCommand(storageDir, "stop", "finished", notifyCommand);
}

/**
 * Builds a hook command that marks the session waiting on the user, then notifies where
 * notifications are on. Built for both PermissionRequest (an approval is about to be asked) and
 * PreToolUse matched to `request_user_input` (a question tool is about to run) — same shape as
 * Claude Code's Notification/PreToolUse split, since the two situations want different toast
 * wording. `id` names the script file, since the two callers must not share one.
 */
function buildWaitingCommand(storageDir: string, id: string, notifyCommand: string | undefined): string {
  return buildMarkCommand(storageDir, id, "waiting", notifyCommand);
}

/**
 * Generates this repository's Codex hook scripts and returns the `-c` argument that registers
 * them, pre-trusted. Everything is scoped to `storageDir` (this agent's own per-repository
 * scratch directory), and nothing is written to Codex's own configuration — `-c` overrides are
 * layered on top of the user's `config.toml` for this one process only, never persisted.
 */
export function setupCodexHooks(
  storageDir: string,
  displayName: string,
  notifications: NotificationSettings,
  repositoryName: string,
  contextFile: string
): string[] {
  // Two commands on the one event: the context file's contents become part of the prompt (a
  // hook's plain, non-JSON stdout is appended to it — confirmed in Codex's own source,
  // `hooks/src/events/user_prompt_submit.rs`, the same contract Claude Code's hooks have), and
  // the marker says the session has started working. Order matters only in that the second must
  // print nothing. Unlike Claude Code, Codex's sandbox restricts writes and network, not reads
  // (`SandboxPolicy::ReadOnly` names no path at all), so — unlike `claude/hooks.ts` — nothing
  // here has to grant the model permission to read the file this one points at.
  const readContextCommand = buildReadFileCommand(storageDir, "read-context", contextFile);
  const busyCommand = buildBusyCommand(storageDir);

  const finishedNotify = notifications.finished
    ? buildNotifyCommand(storageDir, "stop", `${displayName}: Finished`, `Finished in ${repositoryName}`)
    : undefined;
  const stopCommand = buildStopCommand(storageDir, finishedNotify);

  const permissionNotify = notifications.needsYou
    ? buildNotifyCommand(storageDir, "needs-you", `${displayName}: Action needed`, `Waiting for input in ${repositoryName}`)
    : undefined;
  const permissionCommand = buildWaitingCommand(storageDir, "needs-you", permissionNotify);

  const questionNotify = notifications.needsYou
    ? buildNotifyCommand(storageDir, "question", `${displayName}: Question`, `Waiting for your answer in ${repositoryName}`)
    : undefined;
  const questionCommand = buildWaitingCommand(storageDir, "question", questionNotify);

  const entries: HookEntry[] = [
    { event: "UserPromptSubmit", label: "user_prompt_submit", commands: [readContextCommand, busyCommand] },
    { event: "Stop", label: "stop", commands: [stopCommand] },
    { event: "PermissionRequest", label: "permission_request", commands: [permissionCommand] },
    { event: "PreToolUse", label: "pre_tool_use", commands: [questionCommand], matcher: "request_user_input" }
  ];

  return ["-c", buildHooksArg(entries)];
}
