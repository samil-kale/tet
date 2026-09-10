import * as crypto from "node:crypto";
import { hookCommand } from "../../terminals/hook-command";
import { HOST_TARGET, type HookTarget } from "../../terminals/hook-target";

/**
 * Codex only runs a hook once it is *trusted* — a sha256 over a normalized form of its event
 * name, matcher and command, checked against a `trusted_hash` in its own config. An unknown hash
 * opens an interactive session on a blocking "Hooks need review" screen instead of the chat, so
 * tet reproduces the hash and hands it in alongside the hook.
 *
 * `timeout` is always present at its effective value: 600 is the default for every event tet
 * uses, so it must be in the hash even though tet never sets it. Key order is a real recursive
 * alphabetical sort, not the object's own (`matcher` sorts after `hooks`). `async` stays `false`:
 * the installed build refuses an `async` hook ("async hooks are not supported yet") and drops it
 * from the trust listing entirely — revisit once a release actually runs one.
 *
 * If Codex changes this normalization the hash stops matching, the hook shows as "Modified" and
 * the review screen reappears once — not a crash. Cross-check
 * `hooks/src/engine/discovery.rs::hook_hash` and `config/src/fingerprint.rs`.
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
 * The synthetic config path Codex assigns hooks passed on the command line — not a real file,
 * only a trust key shaped like a config file's path. A sandboxed Codex always runs on Linux
 * whatever the host, so this reads `target.posix`, not `process.platform`: the win32 form would
 * compute the wrong trust key for a Windows host's sandbox and reopen the review screen.
 */
function sessionFlagsSource(target: HookTarget): string {
  return target.posix ? "/<session-flags>/config.toml" : String.raw`C:\<session-flags>\config.toml`;
}

/**
 * A hook event's trust key. `handlerIndex` is the handler's position within the event's one
 * matcher group (`group_index` is always `0` — tet registers no second group). Each handler is
 * trusted independently, hashed as if it were alone in its group: verified against Codex's own
 * `hooks/list` that a second handler's key is `…:0:1`, not folded into the first's hash.
 */
function trustKey(eventLabel: string, handlerIndex: number, target: HookTarget): string {
  return `${sessionFlagsSource(target)}:${eventLabel}:0:${handlerIndex}`;
}

/**
 * TOML literal string (`'...'`): everything but `'` itself is taken verbatim, so a Windows path
 * full of backslashes and a PowerShell command line full of `"` need no escaping. A Windows user
 * or repository name can hold a `'`, so that case falls back to a basic string with `\` and `"`
 * escaped, since those do mean something inside one.
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
 * One `-c hooks={…}` argument covering every hook tet registers and its matching trust entry, as
 * a single TOML value: two `-c hooks.…` arguments do not reliably merge (verified — the state
 * entry silently failed to apply), and `-c`'s key-path parsing splits on every literal `.` in the
 * key, corrupting a trust key that contains one (`config.toml`). Inside one value, a real TOML
 * parser handles the quoted trust key and there is nothing left to merge.
 */
function buildHooksArg(entries: HookEntry[], target: HookTarget): string {
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
        return `${tomlValue(trustKey(entry.label, handlerIndex, target))}={trusted_hash=${tomlValue(hash)}}`;
      })
    )
    .join(",");
  return `hooks={${hookGroups},state={${stateEntries}}}`;
}

/**
 * Returns the `-c` argument that registers this repository's Codex hooks, pre-trusted. Nothing
 * is written anywhere: each hook is one `tet-ctl hook <event>` (hook-command.ts), and `-c`
 * overrides apply to this one process only and are never persisted — Codex's own
 * `config.toml` and `hooks.json` are neither read nor touched.
 *
 * One command per event, `UserPromptSubmit` included: a hook's plain, non-JSON stdout is
 * appended to the prompt (`hooks/src/events/user_prompt_submit.rs`), which is exactly what the
 * `prompt-submit` answer is. Stop is the stricter one — a successful command must write one
 * JSON value to stdout — and gets `{}` from the same channel (control-server.ts's `hook`).
 *
 * Codex needs no end-of-turn guard: a turn that only spawns a subagent is reported through
 * `SubagentStop`, which tet does not hook.
 */
export function setupCodexHooks(target: HookTarget = HOST_TARGET): string[] {
  const entries: HookEntry[] = [
    { event: "UserPromptSubmit", label: "user_prompt_submit", commands: [hookCommand("prompt-submit")] },
    { event: "Stop", label: "stop", commands: [hookCommand("stop")] },
    // Waiting is registered for both PermissionRequest (an approval is about to be asked) and
    // PreToolUse matched to `request_user_input` (a question tool is about to run).
    { event: "PermissionRequest", label: "permission_request", commands: [hookCommand("permission")] },
    { event: "PreToolUse", label: "pre_tool_use", commands: [hookCommand("question")], matcher: "request_user_input" }
  ];

  return ["-c", buildHooksArg(entries, target)];
}
