import { nonEmptyString } from "./transcript";

/**
 * The session a hook payload names. Claude Code and Codex put `session_id` — their transcript's
 * id — into every hook's stdin; pi's extension sends the same field. Undefined for non-JSON or no
 * session.
 */
export function hookSessionId(payload: string): string | undefined {
  try {
    return nonEmptyString((JSON.parse(payload) as { session_id?: unknown } | null)?.session_id);
  } catch {
    return undefined;
  }
}

/**
 * The tool call a hook payload is about (AgentTurns.toolCallOf): who made it (`agent_id`, present
 * only on a subagent's), the tool, and what it works on — a command or a file. The same call reads
 * alike in the hook that asks about it and the one that follows its run: Claude Code's
 * `tool_input` is the same there, Codex's differs (a description beside the command), so only the
 * command and the file are taken. Undefined for non-JSON or no tool.
 */
export function hookToolCall(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as {
      tool_name?: unknown;
      tool_input?: { command?: unknown; file_path?: unknown } | null;
      agent_id?: unknown;
    } | null;
    const tool = nonEmptyString(parsed?.tool_name);
    if (!tool) {
      return undefined;
    }
    const target = nonEmptyString(parsed?.tool_input?.command) ?? nonEmptyString(parsed?.tool_input?.file_path) ?? "";
    return JSON.stringify([nonEmptyString(parsed?.agent_id) ?? "", tool, target]);
  } catch {
    return undefined;
  }
}
