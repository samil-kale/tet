import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { findEncodedDir, forgetMissing, nonEmptyString, scanTranscriptTail, truncateTitle } from "../transcript";
import { watchTranscriptDir } from "../../watch-dir";
import { SANDBOX_HOME } from "../../terminals/hook-target";

/** Claude Code has no session CLI: sessions are the `<uuid>.jsonl` transcripts in
 *  ~/.claude/projects/<cwd with non-alphanumerics as "-">; deleting one deletes its transcript.
 *  A sandboxed session is the same file, so operations take the root and cwd as parameters
 *  (SessionProvider.sandbox). */
export const claudeSessionProvider: SessionProvider = {
  list(_executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    return listIn(projectsRoot(), cwd);
  },

  resumeArgs(sessionId: string): string[] {
    return ["--resume", sessionId];
  },

  remove(_executable: string, cwd: string, sessionId: string): Promise<void> {
    return removeIn(projectsRoot(), cwd, sessionId);
  },

  rename(_executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    return renameIn(projectsRoot(), cwd, sessionId, title);
  },

  /** watchTranscriptDir handles a project directory that doesn't exist yet and ignores a
   *  session's `subagents/` subdirectory. */
  watch(_executable: string, cwd: string, onChange: () => void): () => void {
    return watchTranscriptDir(
      projectsRoot,
      () => findProjectDir(projectsRoot(), cwd),
      (filename) => filename.endsWith(".jsonl"),
      onChange
    );
  },

  /** Mounted over the sandbox's `~/.claude/projects`. Measured: sbx gives that path its own volume
   *  (`/dev/vde`); a later `sbx mount` stacks on top and wins, shadowing (not deleting) its content. */
  sandbox: {
    mounts: [{ sub: "projects", target: `${SANDBOX_HOME}/.claude/projects` }],
    list: (_executable, root, cwd) => listIn(path.join(root, "projects"), cwd),
    remove: (_executable, root, cwd, sessionId) => removeIn(path.join(root, "projects"), cwd, sessionId),
    rename: (_executable, root, cwd, sessionId, title) => renameIn(path.join(root, "projects"), cwd, sessionId, title)
  }
};

async function listIn(root: string, cwd: string): Promise<AgentSessionInfo[]> {
  try {
    const projectDir = await findProjectDir(root, cwd);
    if (!projectDir) {
      return [];
    }
    const files = (await fs.promises.readdir(projectDir)).filter((file) => file.endsWith(".jsonl"));
    forgetMissing(projectDir, files, [headCache, scanCache, createdAtCache]);
    const entries = await Promise.all(
      files.map(async (file) => {
        const id = file.slice(0, -".jsonl".length);
        const filePath = path.join(projectDir, file);
        const [tail, stat, createdAt] = await Promise.all([
          scanTail(filePath, id),
          fs.promises.stat(filePath),
          extractCreatedAt(filePath)
        ]);
        const { title, provisional } = await extractTitle(filePath, stat.size, tail);
        return {
          id,
          title,
          updatedAt: stat.mtimeMs,
          provisionalTitle: provisional,
          createdAt: createdAt ?? stat.mtimeMs,
          turnEndedAt: tail.turnEndedAt
        };
      })
    );
    entries.sort((a, b) => a.createdAt - b.createdAt);
    return entries;
  } catch (error) {
    console.error("[tet] claude session listing failed:", error);
    return [];
  }
}

/** A missing project directory or transcript resolves (SessionProvider.remove): the session is
 *  already gone. */
async function removeIn(root: string, cwd: string, sessionId: string): Promise<void> {
  const projectDir = await findProjectDir(root, cwd);
  if (!projectDir) {
    return;
  }
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.promises.rm(filePath, { force: true });
  // Subagent transcripts and tool results sit beside it under the same id.
  await fs.promises.rm(path.join(projectDir, sessionId), { recursive: true, force: true });
  scanCache.delete(filePath);
  headCache.delete(filePath);
  createdAtCache.delete(filePath);
}

/** Mirrors Claude Code's `/rename`: a `custom-title` entry, which outranks every derived title. */
async function renameIn(root: string, cwd: string, sessionId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("title must be non-empty");
  }
  const projectDir = await findProjectDir(root, cwd);
  if (!projectDir) {
    throw new Error("Claude project directory not found");
  }
  const line = JSON.stringify({ type: "custom-title", customTitle: trimmed, sessionId }) + "\n";
  await fs.promises.appendFile(path.join(projectDir, `${sessionId}.jsonl`), line);
}

function projectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

function findProjectDir(root: string, cwd: string): Promise<string | undefined> {
  return findEncodedDir(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

const TITLE_SCAN_BYTE_LIMIT = 256 * 1024;

interface ResolvedTitle {
  title: string;
  /** No name assigned yet — `title` is the first prompt. */
  provisional: boolean;
}

/** Resolves the display name as Claude Code's `/resume` list does (order verified against the
 *  CLI): `custom-title` (anywhere in the file, so from the backwards scan); else "agent-name",
 *  else "ai-title" — the last occurrence wins, the head window's copy is the fallback; else
 *  "summary" (only after `/compact`); else the first typed prompt; else "".
 *
 *  Change with care: a regression silently shows the wrong tab title. */
async function extractTitle(filePath: string, size: number, tail: TranscriptTail): Promise<ResolvedTitle> {
  if (tail.customTitle) {
    return { title: truncateTitle(tail.customTitle), provisional: false };
  }
  const head = await scanHead(filePath, size);
  // The tail's are the file's last and outrank the head's: a resume appends a fresh ai-title,
  // and a long session's lies past the window.
  const assigned = tail.agentName ?? head.agentName ?? tail.aiTitle ?? head.aiTitle ?? head.summary;
  const title = assigned ?? head.firstPrompt;
  return { title: title ? truncateTitle(title) : "", provisional: assigned === undefined };
}

/** The title sources found in a transcript's head window. */
interface TranscriptHead {
  agentName?: string;
  aiTitle?: string;
  summary?: string;
  firstPrompt?: string;
}

/** The last head scan per path (a listing scans every session on any change). Keyed by how much of
 *  the window the file fills: transcripts are append-only, so a full window never changes. */
const headCache = new Map<string, { size: number; head: TranscriptHead }>();

/** Only lines naming one of these are parsed — most of a transcript is not. */
const HEAD_ENTRY_TYPES = ['"agent-name"', '"ai-title"', '"summary"'];

async function scanHead(filePath: string, fileSize: number): Promise<TranscriptHead> {
  const size = Math.min(fileSize, TITLE_SCAN_BYTE_LIMIT);
  const cached = headCache.get(filePath);
  if (cached?.size === size) {
    return cached.head;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: TITLE_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const head: TranscriptHead = {};
  try {
    for await (const line of lines) {
      // Only the first `user` entry; later ones (mostly tool results) go unparsed.
      const wanted =
        HEAD_ENTRY_TYPES.some((type) => line.includes(type)) ||
        (head.firstPrompt === undefined && line.includes('"user"'));
      if (!wanted) {
        continue;
      }
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // agent-name/ai-title keep the last occurrence, summary and prompt the first; an empty
      // value never displaces one.
      if (entry.type === "agent-name") {
        head.agentName = nonEmptyString(entry.agentName) ?? head.agentName;
      } else if (entry.type === "ai-title") {
        head.aiTitle = nonEmptyString(entry.aiTitle) ?? head.aiTitle;
      } else if (entry.type === "summary") {
        head.summary ??= nonEmptyString(entry.summary);
      } else if (head.firstPrompt === undefined && entry.type === "user") {
        // Truncated right away: a pasted prompt can be long.
        const prompt = typedPromptText(entry);
        head.firstPrompt = prompt === undefined ? undefined : truncateTitle(prompt);
      }
    }
    headCache.set(filePath, { size, head });
  } catch (error) {
    console.error("[tet] claude title extraction failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  return head;
}

/** A transcript's first timestamp never changes, so it is read once per path. */
const createdAtCache = new Map<string, number>();

/** The first timestamped entry, steadier than mtime. Not part of extractTitle's scan, which
 *  returns early on a custom-title and would leave renamed sessions without one. */
async function extractCreatedAt(filePath: string): Promise<number | undefined> {
  const cached = createdAtCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: TITLE_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const timestamp = nonEmptyString(entry.timestamp);
      if (timestamp) {
        const ms = Date.parse(timestamp);
        if (!Number.isNaN(ms)) {
          createdAtCache.set(filePath, ms);
          return ms;
        }
      }
    }
  } catch (error) {
    console.error("[tet] claude createdAt extraction failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  return undefined;
}

/** Most `user` entries are tool results; only `origin.kind === "human"` ones are typed prompts. */
function typedPromptText(entry: Record<string, unknown>): string | undefined {
  const origin = entry.origin as { kind?: unknown } | undefined;
  if (origin?.kind !== "human") {
    return undefined;
  }
  const message = entry.message as { content?: unknown } | undefined;
  return nonEmptyString(message?.content);
}

/** What scanTail answers. */
interface TranscriptTail {
  customTitle?: string;
  /** The last ones — Claude appends fresh ones on a resume. */
  agentName?: string;
  aiTitle?: string;
  /** When the last turn ended *without* its Stop hooks running — the one case hooks cannot
   *  report. A turn whose Stop hooks ran is left out even if they left no mark
   *  (claudeHoldsTurnEnd's `background_tasks` guard): the hook is authoritative there. */
  turnEndedAt?: number;
  /** The last turn's end has been checked (readTailEntries); an undefined `turnEndedAt` alone
   * does not say so. */
  turnEndResolved?: boolean;
  /** A `turn_duration` not yet checked for a parent `stop_hook_summary`; resolved by the next
   * turn entry the backward scan visits. */
  pendingTurnEnd?: { ms: number; parentUuid: string };
}

/** Whether every entry the scan looks for has been found. */
function scanComplete(tail: TranscriptTail): boolean {
  return (
    tail.customTitle !== undefined &&
    tail.agentName !== undefined &&
    tail.aiTitle !== undefined &&
    tail.turnEndResolved === true
  );
}

/** Only lines naming one of these are parsed. */
const TAIL_ENTRY_TYPES = [
  '"custom-title"',
  '"agent-name"',
  '"ai-title"',
  '"turn_duration"',
  '"stop_hook_summary"',
  '"[Request interrupted by user'
];

/** The user entry Claude appends when Escape cuts a turn short. Measured (2.1.270): during a tool
 *  ("… for tool use]") a `turn_duration` follows; anywhere else this entry is all there is. */
function isInterruptEntry(entry: Record<string, unknown>): boolean {
  if (entry.type !== "user" || entry.isSidechain === true) {
    return false;
  }
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (part: { type?: unknown; text?: unknown }) =>
        part.type === "text" && typeof part.text === "string" && part.text.startsWith("[Request interrupted by user")
    )
  );
}

/** Reads one stretch's entries from the end into what is still unknown. */
function readTailEntries(lines: string[], sessionId: string, tail: TranscriptTail): void {
  for (let i = lines.length - 1; i >= 0 && !scanComplete(tail); i--) {
    const line = lines[i];
    if (!TAIL_ENTRY_TYPES.some((type) => line.includes(type))) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // A pending turn_duration is resolved by the next *turn* entry below it: its parent
    // stop_hook_summary means Stop hooks ran (nothing to report); any other summary, an earlier
    // turn_duration or an interrupt means it was cut short. Title entries between are skipped —
    // a rename appends a custom-title at any moment.
    if (tail.pendingTurnEnd !== undefined) {
      if (
        (entry.type === "system" &&
          entry.isSidechain !== true &&
          (entry.subtype === "stop_hook_summary" || entry.subtype === "turn_duration")) ||
        isInterruptEntry(entry)
      ) {
        if (!(entry.subtype === "stop_hook_summary" && entry.uuid === tail.pendingTurnEnd.parentUuid)) {
          tail.turnEndedAt = tail.pendingTurnEnd.ms;
        }
        tail.pendingTurnEnd = undefined;
        tail.turnEndResolved = true;
      }
    }
    if (tail.customTitle === undefined && entry.type === "custom-title" && entry.sessionId === sessionId) {
      tail.customTitle = nonEmptyString(entry.customTitle);
    } else if (tail.agentName === undefined && entry.type === "agent-name") {
      tail.agentName = nonEmptyString(entry.agentName);
    } else if (tail.aiTitle === undefined && entry.type === "ai-title") {
      tail.aiTitle = nonEmptyString(entry.aiTitle);
    } else if (
      tail.turnEndResolved === undefined &&
      tail.pendingTurnEnd === undefined &&
      entry.type === "system" &&
      entry.subtype === "turn_duration" &&
      entry.isSidechain !== true &&
      // Also written when background subagents still run — the case the Stop hook holds back
      // for, so this must not end the turn either.
      !(typeof entry.pendingBackgroundAgentCount === "number" && entry.pendingBackgroundAgentCount > 0)
    ) {
      const ms = Date.parse(nonEmptyString(entry.timestamp) ?? "");
      const parentUuid = nonEmptyString(entry.parentUuid);
      if (Number.isNaN(ms) || parentUuid === undefined) {
        // Can't be matched to a Stop hook summary — nothing to report.
        tail.turnEndResolved = true;
      } else {
        tail.pendingTurnEnd = { ms, parentUuid };
      }
    } else if (tail.turnEndResolved === undefined && tail.pendingTurnEnd === undefined && isInterruptEntry(entry)) {
      // A turn cut short without a turn_duration of its own.
      const ms = Date.parse(nonEmptyString(entry.timestamp) ?? "");
      if (!Number.isNaN(ms)) {
        tail.turnEndedAt = ms;
      }
      tail.turnEndResolved = true;
    }
  }
}

/** The last scan per path; only a growing transcript is read again, from where that scan ended. */
const scanCache = new Map<string, { size: number; tail: TranscriptTail }>();

/** Reads backwards for entries whose *last* occurrence counts: custom-title, agent-name and
 *  ai-title (re-appended on a resume), and the last turn's end. Runs to the file's start if
 *  needed — a rename 300 KB ago is still the name. A turn ends with `turn_duration` or, for most
 *  turns cut short, an interrupt entry (isInterruptEntry); sidechain entries are subagent turns. */
function scanTail(filePath: string, sessionId: string): Promise<TranscriptTail> {
  return scanTranscriptTail(filePath, scanCache, {
    byteLimit: TITLE_SCAN_BYTE_LIMIT,
    label: "claude",
    create: (): TranscriptTail => ({}),
    read: (lines, tail) => {
      readTailEntries(lines, sessionId, tail);
      return scanComplete(tail);
    },
    finish: (tail) => {
      // Nothing below a turn_duration: its summary, written right before it, is missing — cut short.
      if (tail.pendingTurnEnd !== undefined) {
        tail.turnEndedAt = tail.pendingTurnEnd.ms;
        tail.pendingTurnEnd = undefined;
        tail.turnEndResolved = true;
      }
    },
    merge: (tail, previous) => {
      tail.customTitle ??= previous.customTitle;
      tail.agentName ??= previous.agentName;
      tail.aiTitle ??= previous.aiTitle;
      // Not ??=: a resolved turnEndedAt may be undefined (Stop hooks ran); only an unresolved
      // scan falls back.
      if (tail.turnEndResolved !== true) {
        tail.turnEndedAt = previous.turnEndedAt;
        tail.turnEndResolved = previous.turnEndResolved;
      }
    }
  });
}
