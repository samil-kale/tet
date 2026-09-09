import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { findEncodedDir, nonEmptyString, scanTranscriptTail, truncateTitle } from "../transcript";
import { watchTranscriptDir } from "../../watch-dir";
import { SANDBOX_HOME } from "../../terminals/hook-target";

/** Claude Code has no session CLI — sessions are the `<uuid>.jsonl` transcripts in
 *  ~/.claude/projects/<cwd with non-alphanumerics replaced by "-">, identified by filename and
 *  ordered by mtime. Deleting one means deleting its transcript. A sandboxed session is the same
 *  file in the same shape, so every operation takes the projects root and the cwd rather than
 *  reading either off this host — see SessionProvider.sandbox. */
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

  /** The project directory doesn't exist until Claude writes a transcript there, and a session's
   *  own `subagents/` subdirectory must not count — watchTranscriptDir covers both. */
  watch(_executable: string, cwd: string, onChange: () => void): () => void {
    return watchTranscriptDir(
      projectsRoot,
      () => findProjectDir(projectsRoot(), cwd),
      (filename) => filename.endsWith(".jsonl"),
      onChange
    );
  },

  /** `~/.claude/projects` inside the sandbox, where a sandboxed Claude writes the same
   *  transcripts it writes on the host. Measured: sbx gives that path a volume of its own
   *  (`/dev/vde`), and a later `sbx mount` stacks on top and wins, so what the CLI writes lands
   *  on the host side; what the volume already held is shadowed by the mount, not deleted. */
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
    forgetMissing(projectDir, files);
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

async function removeIn(root: string, cwd: string, sessionId: string): Promise<void> {
  const projectDir = await findProjectDir(root, cwd);
  if (!projectDir) {
    throw new Error("Claude project directory not found");
  }
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.promises.rm(filePath);
  // Claude Code keeps subagent transcripts and tool results beside it under the same id.
  await fs.promises.rm(path.join(projectDir, sessionId), { recursive: true, force: true });
  scanCache.delete(filePath);
  headCache.delete(filePath);
  createdAtCache.delete(filePath);
}

/** Mirrors Claude Code's `/rename`: a rename is persisted as a `custom-title` transcript entry,
 *  which always wins over the derived `ai-title`/`summary`/message fallback. */
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

/** Drops what the three caches hold for transcripts that are gone — Claude Code's own picker
 *  deletes them behind tet's back, and without this the caches only ever grow. Scoped to the
 *  directory just listed: a sandbox's transcripts are read from a second root
 *  (SessionProvider.sandbox) into these same caches, and unscoped each pass would evict the
 *  other root's entries. */
function forgetMissing(dir: string, files: string[]): void {
  const present = new Set(files.map((file) => path.join(dir, file)));
  for (const cache of [headCache, scanCache, createdAtCache]) {
    for (const filePath of cache.keys()) {
      if (path.dirname(filePath) === dir && !present.has(filePath)) {
        cache.delete(filePath);
      }
    }
  }
}

const TITLE_SCAN_BYTE_LIMIT = 256 * 1024;

interface ResolvedTitle {
  title: string;
  /** No name assigned by Claude yet — `title` is the first prompt standing in for one. */
  provisional: boolean;
}

/** Resolves a session's display name the way Claude Code's own `/resume` list does (order
 *  verified against the CLI): `custom-title` wins and can sit anywhere in the file, so it comes
 *  from the caller's backwards scan; else "agent-name", else "ai-title" — for both the last
 *  occurrence in the file wins, the head window's copy being the fallback; else "summary" (only
 *  seen after `/compact`); else the first prompt the user typed. Falls back to "".
 *
 *  Don't change this scanning logic casually: a regression silently shows the wrong tab title. */
async function extractTitle(filePath: string, size: number, tail: TranscriptTail): Promise<ResolvedTitle> {
  if (tail.customTitle) {
    return { title: truncateTitle(tail.customTitle), provisional: false };
  }
  const head = await scanHead(filePath, size);
  // The tail scan's are the last in the whole file and outrank what this window holds:
  // Claude appends a fresh ai-title on a resume, and a long session's is past the window.
  const assigned = tail.agentName ?? head.agentName ?? tail.aiTitle ?? head.aiTitle ?? head.summary;
  const title = assigned ?? head.firstPrompt;
  return { title: title ? truncateTitle(title) : "", provisional: assigned === undefined };
}

/** What the head window of a transcript holds of the entries a title is derived from. */
interface TranscriptHead {
  agentName?: string;
  aiTitle?: string;
  summary?: string;
  firstPrompt?: string;
}

/** The last head scan of each transcript, by path: a listing runs for every session on every
 *  change to any of them. Keyed by how much of the window the file fills rather than by its size
 *  — only the first TITLE_SCAN_BYTE_LIMIT bytes are ever read, and a transcript is append-only,
 *  so past that the window never changes again. */
const headCache = new Map<string, { size: number; head: TranscriptHead }>();

/** Only a line naming one of the entry types is worth parsing — most of a transcript is not. */
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
      // Only the first `user` entry is wanted; later ones (mostly tool results) go unparsed.
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
      // agent-name/ai-title keep the last occurrence, summary and the first prompt the first;
      // an empty value never displaces what's already there.
      if (entry.type === "agent-name") {
        head.agentName = nonEmptyString(entry.agentName) ?? head.agentName;
      } else if (entry.type === "ai-title") {
        head.aiTitle = nonEmptyString(entry.aiTitle) ?? head.aiTitle;
      } else if (entry.type === "summary") {
        head.summary ??= nonEmptyString(entry.summary);
      } else if (head.firstPrompt === undefined && entry.type === "user") {
        // Truncated on the way in: a pasted prompt can be long, and only its start is kept.
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

/** A transcript's first timestamp never changes once it has one, so it is read once per path. */
const createdAtCache = new Map<string, number>();

/** A transcript's first timestamped entry is a more stable "created" signal than mtime, which
 *  shifts on every append. Kept out of extractTitle's scan: that one returns early on a
 *  custom-title, which would leave every renamed session without a createdAt. */
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

/** Most `user` entries are tool results the CLI writes back into the transcript itself; only
 *  those tagged `origin.kind === "human"` are prompts the user typed. */
function typedPromptText(entry: Record<string, unknown>): string | undefined {
  const origin = entry.origin as { kind?: unknown } | undefined;
  if (origin?.kind !== "human") {
    return undefined;
  }
  const message = entry.message as { content?: unknown } | undefined;
  return nonEmptyString(message?.content);
}

/** What the backwards scan of a transcript answers — see scanTail. */
interface TranscriptTail {
  /** The last `custom-title` entry, if the transcript holds one. */
  customTitle?: string;
  /** The last `agent-name` and `ai-title` entries — Claude appends fresh ones on a resume. */
  agentName?: string;
  aiTitle?: string;
  /** When the last turn ended *without* its Stop hooks ever running for it — the one case the
   *  markers cannot report. A turn whose Stop hooks did run is left out even when they wrote no
   *  `finished` marker (the `background_tasks` guard in stop-guard.ps1): the marker mechanism is
   *  authoritative for that turn. Resolved via `pendingTurnEnd` below. */
  turnEndedAt?: number;
  /** Set once a `turn_duration` entry's Stop-hook parentage has been checked — see
   * readTailEntries. Distinct from `turnEndedAt` being undefined, which says nothing about
   * whether that check has happened. */
  turnEndResolved?: boolean;
  /** A `turn_duration` entry not yet checked against its parent for a matching
   * `stop_hook_summary` — resolved by whichever entry the backward scan visits next. */
  pendingTurnEnd?: { ms: number; parentUuid: string };
}

/** What is left of a transcript's scan once every entry it looks for has been found. */
function scanComplete(tail: TranscriptTail): boolean {
  return (
    tail.customTitle !== undefined &&
    tail.agentName !== undefined &&
    tail.aiTitle !== undefined &&
    tail.turnEndResolved === true
  );
}

/** Only a line naming one of the entry types is worth parsing — most of a transcript is not. */
const TAIL_ENTRY_TYPES = [
  '"custom-title"',
  '"agent-name"',
  '"ai-title"',
  '"turn_duration"',
  '"stop_hook_summary"'
];

/** Reads the entries in one stretch of a transcript from the end, into what is still unknown. */
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
    // A pending turn_duration is resolved by the next *turn* entry below it: a stop_hook_summary
    // it names as its parent means Stop hooks ran (nothing to report); any other summary or an
    // earlier turn's own turn_duration means this turn had none, i.e. it was cut short. A title
    // entry between the two is skipped — a rename appends a custom-title at any moment.
    if (tail.pendingTurnEnd !== undefined) {
      if (
        entry.type === "system" &&
        entry.isSidechain !== true &&
        (entry.subtype === "stop_hook_summary" || entry.subtype === "turn_duration")
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
      // Written as well when the turn returns with subagents still running in the background
      // — the case the Stop hook holds its marker back for, so this must not end it either.
      !(typeof entry.pendingBackgroundAgentCount === "number" && entry.pendingBackgroundAgentCount > 0)
    ) {
      const ms = Date.parse(nonEmptyString(entry.timestamp) ?? "");
      const parentUuid = nonEmptyString(entry.parentUuid);
      if (Number.isNaN(ms) || parentUuid === undefined) {
        // Can't be correlated to a Stop hook summary either way - nothing to report.
        tail.turnEndResolved = true;
      } else {
        tail.pendingTurnEnd = { ms, parentUuid };
      }
    }
  }
}

/** The last scan of each transcript, by path: all but the one being written to are answered from
 *  here, and that one is only read from where the last scan left off. */
const scanCache = new Map<string, { size: number; tail: TranscriptTail }>();

/** Reads the transcript backwards for the entries that can sit anywhere in it and of which the
 *  *last* one counts: custom-title, the agent-name and ai-title Claude re-appends on a resume,
 *  and when the last turn ended. It runs to the beginning of the file where a session has none
 *  of them, since a rename made 300 KB of transcript ago is still the name. Claude writes a
 *  `turn_duration` entry when a turn ends whichever way it ended; sidechain entries are a
 *  subagent's own turns. */
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
      // A turn_duration with nothing below it to check against: a summary is written right before
      // its turn_duration, so there is none — the turn was cut short. Never left pending.
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
      // Not ??=: turnEndedAt legitimately stays undefined once resolved (Stop hooks ran), which
      // a superseded earlier answer must not overwrite. Only an unresolved scan falls back.
      if (tail.turnEndResolved !== true) {
        tail.turnEndedAt = previous.turnEndedAt;
        tail.turnEndResolved = previous.turnEndResolved;
      }
    }
  });
}
