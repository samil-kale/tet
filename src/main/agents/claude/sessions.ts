import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentSessionInfo, SessionProvider } from "../agent";
import { nonEmptyString, readLinesBackwards, truncateTitle } from "../transcript";
import { watchedDirectoryGone } from "../../watch-dir";

/**
 * Claude Code has no session CLI — sessions are the `<uuid>.jsonl` transcripts in
 * ~/.claude/projects/<cwd with non-alphanumerics replaced by "-">, identified by
 * filename and ordered by mtime. Deleting a session means deleting its transcript.
 */
export const claudeSessionProvider: SessionProvider = {
  async list(_executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    try {
      const projectDir = await findProjectDir(cwd);
      if (!projectDir) {
        return [];
      }
      const files = (await fs.promises.readdir(projectDir)).filter((file) => file.endsWith(".jsonl"));
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
  },

  resumeArgs(sessionId: string): string[] {
    return ["--resume", sessionId];
  },

  async remove(_executable: string, cwd: string, sessionId: string): Promise<void> {
    const projectDir = await findProjectDir(cwd);
    if (!projectDir) {
      throw new Error("Claude project directory not found");
    }
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.promises.rm(filePath);
    // What Claude Code keeps beside the transcript under the same id — subagent transcripts,
    // tool results — and would otherwise stay behind for good.
    await fs.promises.rm(path.join(projectDir, sessionId), { recursive: true, force: true });
    scanCache.delete(filePath);
    headCache.delete(filePath);
    createdAtCache.delete(filePath);
  },

  /**
   * Mirrors Claude Code's own (CLI-flag-less) `/rename` slash command: a rename is persisted
   * as a `custom-title` transcript entry, which — like Claude's own title resolution — always
   * wins over the derived `ai-title`/`summary`/message fallback.
   */
  async rename(_executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title must be non-empty");
    }
    const projectDir = await findProjectDir(cwd);
    if (!projectDir) {
      throw new Error("Claude project directory not found");
    }
    const line = JSON.stringify({ type: "custom-title", customTitle: trimmed, sessionId }) + "\n";
    await fs.promises.appendFile(path.join(projectDir, `${sessionId}.jsonl`), line);
  },

  /**
   * Watches the project's transcripts. Non-recursive on purpose: a write inside a session's
   * own `subagents/` subdirectory then doesn't fire at all, and the directory entries that do
   * fire are filtered out by extension.
   *
   * Two-stage because the project directory doesn't exist until Claude first writes a
   * transcript there, and fs.watch throws ENOENT on a missing one: until then, watch the
   * projects root (which does report the new directory appearing) and arm the real watcher
   * once it shows up.
   */
  watch(_executable: string, cwd: string, onChange: () => void): () => void {
    let projectWatcher: fs.FSWatcher | undefined;
    let rootWatcher: fs.FSWatcher | undefined;
    let stopped = false;

    const armProjectWatcher = async (): Promise<void> => {
      if (stopped || projectWatcher) {
        return;
      }
      // Rejects when the projects root itself is absent (Claude never ran here) — that's
      // the normal starting state for a fresh install, not a failure worth reporting.
      const projectDir = await findProjectDir(cwd).catch(() => undefined);
      if (!projectDir || stopped || projectWatcher) {
        return;
      }
      const onEvent = (_eventType: string, filename: string | null): void => {
        // The directory itself deleted (a cleared `~/.claude/projects`): back to the first
        // stage, which arms this again once Claude recreates it.
        if (watchedDirectoryGone(projectDir, filename)) {
          projectWatcher?.close();
          projectWatcher = undefined;
          armRootWatcher();
          return;
        }
        // A null filename means "something here changed" on platforms that don't report
        // it — reconciling then is the safe read.
        if (filename === null || filename.endsWith(".jsonl")) {
          onChange();
        }
      };
      try {
        projectWatcher = fs.watch(projectDir, onEvent);
      } catch {
        // Gone again between the lookup and the watch, or no descriptor left for one: the
        // listing stays polled, as it is before Claude ever ran here. Codex and opencode
        // guard their watch the same way.
        return;
      }
      rootWatcher?.close();
      rootWatcher = undefined;
    };

    const armRootWatcher = (): void => {
      if (stopped || projectWatcher || rootWatcher) {
        return;
      }
      try {
        rootWatcher = fs.watch(projectsRoot(), () => void armProjectWatcher());
      } catch {
        // Claude has never run on this machine — nothing to watch, listing stays polled.
      }
    };

    void armProjectWatcher().then(armRootWatcher);

    return () => {
      stopped = true;
      projectWatcher?.close();
      rootWatcher?.close();
    };
  }
};

function projectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

async function findProjectDir(cwd: string): Promise<string | undefined> {
  const projectsDir = projectsRoot();
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  // Windows paths are case-insensitive and the CLI preserves whatever casing it saw,
  // so the same project can have differently-cased directories there.
  const ignoreCase = process.platform === "win32";
  const wanted = ignoreCase ? encoded.toLowerCase() : encoded;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(projectsDir);
  } catch (error) {
    // No projects root at all — Claude Code has never run on this machine — is the same
    // answer as no directory for this project: no sessions, not a failure to report.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  for (const entry of entries) {
    if ((ignoreCase ? entry.toLowerCase() : entry) === wanted) {
      return path.join(projectsDir, entry);
    }
  }
  return undefined;
}

const TITLE_SCAN_BYTE_LIMIT = 256 * 1024;

interface ResolvedTitle {
  title: string;
  /** No name assigned by Claude yet — `title` is the first prompt standing in for one. */
  provisional: boolean;
}

/**
 * Resolves a session's display name the same way Claude Code's own `/resume` list does
 * (order verified against the CLI, including that a rename outranks an "agent-name"):
 * a `custom-title` entry (Claude's own `/rename`, and what our rename writes) wins; it can
 * sit anywhere in the file, so it comes from the backwards scan the caller has already run
 * rather than from the head window below. Otherwise "agent-name", else "ai-title" — for both
 * the last occurrence in the file wins, since a later one supersedes an earlier one, and that
 * one is the scan's as well; the head window's own copy is the fallback. Else
 * a "summary" entry (only seen after `/compact`), else the first prompt the user typed:
 * Claude assigns no title at all to short sessions, and `/resume` labels those by that
 * prompt rather than leaving them blank. Falls back to "" — the UI shows a placeholder.
 *
 * Don't change this scanning logic casually: a regression here silently shows the wrong
 * tab title with nothing to catch it.
 */
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

/**
 * The last head scan of each transcript, by path, for the same reason `scanCache` below
 * exists: a listing runs for every session on every change to any of them. Keyed by how much of
 * the window the file fills rather than by its size — the stream only ever reads the first
 * TITLE_SCAN_BYTE_LIMIT bytes, and a transcript is append-only, so once it has grown past that
 * the window never changes again, however much the session being worked in keeps growing.
 */
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
      // The prompt is wanted from the first `user` entry only; after that, `user` lines — the
      // bulk of a transcript, tool results included — are skipped unparsed like the rest.
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
      // agent-name/ai-title keep the last occurrence (a later one supersedes an earlier
      // one), summary and the first prompt the first — an empty value never displaces
      // what's already there either way.
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

/**
 * A transcript's own first timestamped entry is a far more stable "created" signal than the
 * file's mtime, which shifts on every append. Deliberately independent of extractTitle rather
 * than folded into its scan: that one returns early once it finds a custom-title, skipping its
 * head-scan — reusing it here would leave every renamed session without a createdAt.
 */
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

/**
 * Most `user` entries are tool results the CLI writes back into the transcript itself; only
 * those tagged `origin.kind === "human"` are prompts the user typed.
 */
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
  /**
   * When the last turn ended *without* its Stop hooks ever running for it — the one case the
   * busy/finished/waiting markers have no other way to report, and what AgentSessionInfo.
   * turnEndedAt exists for. A turn whose Stop hooks did run is left out even when they chose not
   * to write a `finished` marker (a background task still pending, per the `background_tasks`
   * guard in stop-guard.ps1): the marker mechanism is authoritative for that turn either way, and
   * this net exists only for the turn hooks never got a chance to run for at all. Resolved via
   * `pendingTurnEnd` below rather than read here directly.
   */
  turnEndedAt?: number;
  /** Set once a `turn_duration` entry's Stop-hook parentage has been checked one way or the
   * other — see readTailEntries. Internal to the scan; distinct from `turnEndedAt` being
   * undefined, which by itself does not say whether that check has even happened yet. */
  turnEndResolved?: boolean;
  /** A `turn_duration` entry found but not yet checked against its parent for a matching
   * `stop_hook_summary` — resolved by whichever entry the backward scan visits next, whatever
   * kind it is. */
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
    // it names as its parent means Stop hooks ran (nothing to report - see turnEndedAt's own
    // comment); any other summary or an earlier turn's own turn_duration means this turn had no
    // summary of its own, i.e. it was cut short before any hook fired. A title entry between
    // the two says nothing either way and is skipped - a rename appends a custom-title at any
    // moment, and treating that as "no summary" would end a turn that finished normally.
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

/**
 * The last scan of each transcript, by path: a listing runs for every session of the
 * repository and on every change to any of them, so all but the one being written to are
 * answered from here, and that one is only read from where the last scan left off.
 */
const scanCache = new Map<string, { size: number; tail: TranscriptTail }>();

/**
 * Reads the transcript backwards for the entries that can sit anywhere in it and of which the
 * *last* one counts: the custom-title (Claude's own `/rename`, and what our rename appends),
 * the agent-name and ai-title Claude re-appends on a resume, and when the last turn ended.
 * Backwards, so it stops as soon as it has them all — and to the beginning of the file where a
 * session has none of them, since a rename made 300 KB of transcript ago is still the name.
 * Only lines naming one of those types are parsed, most of a transcript being tool output.
 *
 * Claude writes a `turn_duration` entry when a turn ends whichever way it ended — the one after
 * an interrupted turn is what the Stop hook never reports, and what AgentSessionInfo.turnEndedAt
 * exists for. Sidechain entries are a subagent's own turns, not the session's.
 *
 * A file scanned before is only read from a chunk below where that scan ended, and what the
 * new stretch does not hold is taken from the old answer: the entries below the overlap were
 * all seen then, and the overlap covers a line the earlier read may have caught half-written.
 */
async function scanTail(filePath: string, sessionId: string): Promise<TranscriptTail> {
  const tail: TranscriptTail = {};
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const { size } = await handle.stat();
    const cached = scanCache.get(filePath);
    if (cached?.size === size) {
      return cached.tail;
    }
    const previous = cached && cached.size < size ? cached : undefined;
    const floor = previous ? Math.max(0, previous.size - TITLE_SCAN_BYTE_LIMIT) : 0;
    await readLinesBackwards(handle, size, floor, TITLE_SCAN_BYTE_LIMIT, (lines) => {
      readTailEntries(lines, sessionId, tail);
      return scanComplete(tail);
    });
    // A turn_duration with nothing below it to check against: the whole stretch under it held
    // no summary and no earlier turn, and a summary is written right before its turn_duration,
    // so there is none - the turn was cut short. Never left pending into the cache.
    if (tail.pendingTurnEnd !== undefined) {
      tail.turnEndedAt = tail.pendingTurnEnd.ms;
      tail.pendingTurnEnd = undefined;
      tail.turnEndResolved = true;
    }
    if (previous) {
      tail.customTitle ??= previous.tail.customTitle;
      tail.agentName ??= previous.tail.agentName;
      tail.aiTitle ??= previous.tail.aiTitle;
      // Not ??=: turnEndedAt legitimately stays undefined once resolved (Stop hooks ran, so
      // there's nothing to report), and that must not be overwritten by a now-superseded answer
      // from before. Only an unresolved scan - one that ran out of newly-read material with a
      // turn_duration still unconfirmed, or none at all in the new stretch - falls back to it.
      if (tail.turnEndResolved !== true) {
        tail.turnEndedAt = previous.tail.turnEndedAt;
        tail.turnEndResolved = previous.tail.turnEndResolved;
      }
    }
    scanCache.set(filePath, { size, tail });
  } catch (error) {
    console.error("[tet] claude transcript scan failed:", error);
  } finally {
    await handle?.close();
  }
  return tail;
}
