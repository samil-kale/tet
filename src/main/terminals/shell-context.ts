import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { ANSI_SEQUENCE_AT_START, stripAnsi } from "../../shared/ansi";
import { WIN_BOM } from "../../shared/script-text";

const WRITE_DEBOUNCE_MS = 250;
/** The longest a write is held back under continuous output. */
const WRITE_MAX_WAIT_MS = 2000;
/** Retry of a failed write (on win32, a reader holding the file without delete sharing), rather
 *  than waiting for more output. */
const WRITE_RETRY_MS = 1000;
const MAX_LOG_CHARS = 500_000;
const LOG_TRUNCATION_NOTE = "... [earlier output dropped, showing most recent]\n";
// PowerShell 5.1's Get-Content reads BOM-less files as ANSI, garbling non-ASCII output.
const CONTEXT_FILE_BOM = process.platform === "win32" ? WIN_BOM : "";

/** Write beside and rename: another process reads these, and on Windows a read mid-write fails. No
 *  fsync: rewritten every few hundred milliseconds under output, and a transcript lost to a crash
 *  costs nothing. */
function replaceFile(file: string, contents: string): Promise<void> {
  return writeFileAtomic(file, contents, { fsync: false });
}

class CappedLogFile {
  private content = "";
  private truncated = false;
  private dirty = false;
  /** Chained, not concurrent — a failed write is handled after the writes before it. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onFailure: () => void
  ) {}

  get chars(): number {
    return this.content.length;
  }

  append(text: string): void {
    this.content += text;
    // Trimmed at twice the cap, to the cap in flush(): trimming per chunk would copy 0.5 MB per read.
    if (this.content.length > 2 * MAX_LOG_CHARS) {
      this.trim();
    }
    this.dirty = true;
  }

  private trim(): void {
    if (this.content.length > MAX_LOG_CHARS) {
      this.content = this.content.slice(-MAX_LOG_CHARS);
      this.truncated = true;
    }
  }

  flush(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    this.trim();
    const contents = this.truncated ? LOG_TRUNCATION_NOTE + this.content : this.content;
    this.writing = this.writing
      .then(() => replaceFile(this.file, contents))
      .catch((error) => {
        console.error(`[tet] failed to write ${path.basename(this.file)}:`, error);
        this.dirty = true;
        this.onFailure();
      });
  }
}

/** Strips escape sequences and keeps what follows a line's last bare `\r` — a progress bar's
 *  redraws leave the line as finally shown. */
function cleanTerminalOutput(data: string): string {
  return stripAnsi(data)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** The most of a chunk held back for the next one. */
const MAX_CARRY = 4096;

/** Where to cut a chunk so `cleanTerminalOutput` sees whole lines: a chunk ending in the `\r` of a
 *  `\r\n` would lose its line to the carriage-return rule, and a split escape sequence would leave
 *  both halves in the log. The rest waits for the next chunk, up to MAX_CARRY. */
function carryFrom(data: string): number {
  const newline = data.lastIndexOf("\n");
  if (data.length - newline - 1 < MAX_CARRY) {
    return newline + 1;
  }
  const escape = data.lastIndexOf("\x1b");
  if (escape !== -1 && data.length - escape < MAX_CARRY && !ANSI_SEQUENCE_AT_START.test(data.slice(escape))) {
    return escape;
  }
  return data.length;
}

/**
 * The context file an agent is pointed at, and the capped transcript of the project's shell tabs
 * (not agent tabs — that output is a TUI redrawing). Tabs write in arrival order, never mid-line
 * (each holds its unfinished line back), with a header at every change of tab. An agent gets no
 * editor context; this transcript is what it gets instead.
 */
export class ShellContext {
  private readonly log: CappedLogFile;
  /** The pending flush, a debounced one or a retry; undefined once it has run. */
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The latest the next flush may come; set on the first append after a flush. */
  private flushDeadline: number | undefined;
  /** What the context says, whether or not the file holds it yet. */
  private contents = "";
  /** What was last written, so an unchanged context isn't rewritten. */
  private written: string | undefined;
  private disposed = false;
  /** Chained, not concurrent — a failed write is handled after the writes before it. */
  private writing: Promise<void> = Promise.resolve();
  /** Per tab, the tail of its last chunk held back for the next one. */
  private readonly carries = new Map<string, string>();
  /** The tab the log currently ends in; any other opens a new section. */
  private lastWriter: string | undefined;

  constructor(
    private readonly directory: string,
    private readonly repositoryName: string
  ) {
    fs.mkdirSync(directory, { recursive: true });
    this.log = new CappedLogFile(this.logFile, () => this.retryLater());
    // Written up front: an absent file makes the agent's hook fail rather than say nothing.
    this.writeContext();
  }

  get logFile(): string {
    return path.join(this.directory, "shell-output.log");
  }

  get contextFile(): string {
    return path.join(this.directory, "context.md");
  }

  /** The file's text for `prompt-submit` over the control channel — even while writing it fails.
   *  Without the BOM, which is only for PowerShell. */
  get text(): string {
    return this.contents;
  }

  /** `label` names the tab in a section header. */
  append(tabId: string, label: string, data: string): void {
    const whole = (this.carries.get(tabId) ?? "") + data;
    const cut = carryFrom(whole);
    this.carries.set(tabId, whole.slice(cut));
    this.write(tabId, label, cleanTerminalOutput(whole.slice(0, cut)));
  }

  /** A closed tab's unfinished line has no next chunk to wait for. */
  close(tabId: string): void {
    const carry = this.carries.get(tabId);
    this.carries.delete(tabId);
    if (carry) {
      this.write(tabId, tabId, cleanTerminalOutput(carry));
    }
  }

  private write(tabId: string, label: string, text: string): void {
    if (text === "") {
      return;
    }
    if (tabId !== this.lastWriter) {
      this.lastWriter = tabId;
      this.log.append(`${this.log.chars === 0 ? "" : "\n"}=== shell tab: ${label} ===\n`);
    }
    this.log.append(text);
    // Capped by the deadline: a build or `tail -f` never pauses long enough for the debounce alone.
    const now = Date.now();
    this.flushDeadline ??= now + WRITE_MAX_WAIT_MS;
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), Math.min(WRITE_DEBOUNCE_MS, Math.max(0, this.flushDeadline - now)));
  }

  private flush(): void {
    this.writeTimer = undefined;
    this.flushDeadline = undefined;
    this.log.flush();
    this.writeContext();
  }

  /** A pending flush writes everything anyway, so only one is armed. */
  private retryLater(): void {
    if (!this.disposed && this.writeTimer === undefined) {
      this.writeTimer = setTimeout(() => this.flush(), WRITE_RETRY_MS);
    }
  }

  private writeContext(): void {
    // The `tet-ctl` line is always there — nothing else tells an agent about it. The shell
    // paragraph only once something ran.
    const contents = [
      "<tet_context>",
      "You are running inside TET. Its own settings, projects and terminal tabs are",
      "controlled with `tet-ctl` (run `tet-ctl help`) — use it when the user asks",
      "about TET itself, not for work on the repository.",
      ...(this.log.chars === 0
        ? []
        : [
            "",
            `Shell output from the user's shell tabs in ${this.repositoryName}: ${this.logFile}`,
            "Read that file when the user asks about something they ran in a shell."
          ]),
      "</tet_context>",
      "This is the state of the user's workspace at the time the message was sent." +
        " It may or may not be relevant to the request."
    ].join("\n");
    this.contents = contents;
    if (contents === this.written) {
      return;
    }
    this.written = contents;
    this.writing = this.writing
      .then(() => replaceFile(this.contextFile, CONTEXT_FILE_BOM + contents))
      .catch((error) => {
        console.error("[tet] failed to write the context file:", error);
        // Not on disk, so the next write must not be skipped as unchanged.
        this.written = undefined;
        this.retryLater();
      });
  }

  dispose(): void {
    this.disposed = true;
    for (const tabId of [...this.carries.keys()]) {
      this.close(tabId);
    }
    clearTimeout(this.writeTimer);
    this.log.flush();
  }
}
