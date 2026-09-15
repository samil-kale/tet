import * as crypto from "node:crypto";
import { hookCommand } from "../../terminals/hook-command";
import { HOST_TARGET, type HookTarget } from "../../terminals/hook-target";

/**
 * Codex runs only *trusted* hooks: a sha256 over the normalized event name, matcher and command,
 * matched against a `trusted_hash` in its config. An unknown hash opens a blocking "Hooks need
 * review" screen, so tet reproduces the hash and passes it with the hook.
 *
 * `timeout` is hashed at its effective value, 600 (the default for every event tet uses). Keys
 * sort recursively alphabetical (`matcher` after `hooks`). `async` stays `false`: the build
 * refuses async hooks ("async hooks are not supported yet") and drops them from the trust listing.
 *
 * A changed normalization only shows the hook as "Modified" and the review screen once. Cross-check
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
 * The synthetic config path Codex assigns command-line hooks, used only in trust keys. A sandboxed
 * Codex runs on Linux whatever the host, hence `target.posix`, not `process.platform` — the win32
 * form would reopen the review screen in a Windows host's sandbox.
 */
function sessionFlagsSource(target: HookTarget): string {
  return target.posix ? "/<session-flags>/config.toml" : String.raw`C:\<session-flags>\config.toml`;
}

/**
 * A hook's trust key: `handlerIndex` within the event's one matcher group (`group_index` always
 * `0`). Each handler is hashed as if alone: verified against Codex's `hooks/list`, a second
 * handler's key is `…:0:1`.
 */
function trustKey(eventLabel: string, handlerIndex: number, target: HookTarget): string {
  return `${sessionFlagsSource(target)}:${eventLabel}:0:${handlerIndex}`;
}

/**
 * A TOML literal string (`'...'`), verbatim so backslashes and `"` need no escaping. A value
 * holding `'` (a user or repository name can) falls back to a basic string with `\` and `"` escaped.
 */
function tomlValue(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface HookEntry {
  /** PascalCase, as in `config.toml`. */
  event: string;
  /** snake_case, as in a trust key. */
  label: string;
  /** In registration order. */
  commands: string[];
  /** Only `PreToolUse` needs one. */
  matcher?: string;
}

/**
 * One `-c hooks={…}` value with every hook and its trust entry: separate `-c hooks.…` arguments do
 * not reliably merge (verified: the state entry silently did not apply), and `-c`'s key path splits
 * on every `.`, corrupting a trust key like `config.toml`. Inside one value, a real TOML parser
 * reads the quoted key.
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
 * The `-c` argument registering Codex's hooks, pre-trusted. Nothing is written: each hook is a
 * `tet-ctl hook <event>` (hook-command.ts), and `-c` applies to this process only — Codex's
 * `config.toml` and `hooks.json` are never touched.
 *
 * One command per event: `UserPromptSubmit`'s plain stdout is appended to the prompt
 * (`hooks/src/events/user_prompt_submit.rs`), which is the `prompt-submit` answer. Stop must write
 * one JSON value and gets `{}` (control-server.ts's `hook`).
 *
 * No end-of-turn guard: a subagent-only turn reports through `SubagentStop`, which tet does not hook.
 */
export function setupCodexHooks(target: HookTarget = HOST_TARGET): string[] {
  const entries: HookEntry[] = [
    { event: "UserPromptSubmit", label: "user_prompt_submit", commands: [hookCommand("prompt-submit")] },
    { event: "Stop", label: "stop", commands: [hookCommand("stop")] },
    // Waiting: an approval about to be asked, or the question tool about to run.
    { event: "PermissionRequest", label: "permission_request", commands: [hookCommand("permission")] },
    { event: "PreToolUse", label: "pre_tool_use", commands: [hookCommand("question")], matcher: "request_user_input" }
  ];

  return ["-c", buildHooksArg(entries, target)];
}
