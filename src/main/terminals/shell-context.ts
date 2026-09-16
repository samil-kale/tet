import * as fs from "node:fs";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { ANSI_SEQUENCE_AT_START, stripAnsi } from "../../shared/ansi";
import { WIN_BOM } from "../../shared/script-text";

/** Retry of a failed write (on win32, a reader holding the file without delete sharing). */
const WRITE_RETRY_MS = 1000;
/** Lines kept per shell tab — `tabs-shell-output`'s most. */
const MAX_LINES = 10_000;
// PowerShell 5.1's Get-Content reads BOM-less files as ANSI, garbling non-ASCII output.
const CONTEXT_FILE_BOM = process.platform === "win32" ? WIN_BOM : "";

/** Write beside and rename: another process reads it, and on Windows a read mid-write fails. No
 *  fsync: it is written anew at every start. */
function replaceFile(file: string, contents: string): Promise<void> {
  return writeFileAtomic(file, contents, { fsync: false });
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
 *  both halves in the lines. The rest waits for the next chunk, up to MAX_CARRY. */
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
 * The context file an agent is pointed at, and the latest lines of each of the project's shell tabs
 * for `tabs-shell-output` (not agent tabs — that output is a TUI redrawing). Each tab holds its
 * unfinished line back for the next chunk. An agent gets no editor context; these lines are what it
 * gets instead.
 */
export class ShellContext {
  /** Per tab, oldest first; the last line is still open (empty after a newline). */
  private readonly lines = new Map<string, string[]>();
  /** Per tab, the tail of its last chunk held back for the next one. */
  private readonly carries = new Map<string, string>();
  /** Whether a shell tab printed anything yet; the context mentions shell output only then. */
  private shellPrinted = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the context says, whether or not the file holds it yet. */
  private contents = "";
  /** What was last written, so an unchanged context isn't rewritten. */
  private written: string | undefined;
  private disposed = false;
  /** Chained, not concurrent — a failed write is handled after the writes before it. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly repositoryName: string
  ) {
    fs.mkdirSync(directory, { recursive: true });
    // Written up front: an absent file makes the agent's hook fail rather than say nothing.
    this.writeContext();
  }

  get contextFile(): string {
    return path.join(this.directory, "context.md");
  }

  /** The file's text for `prompt-submit` over the control channel — even while writing it fails.
   *  Without the BOM, which is only for PowerShell. */
  get text(): string {
    return this.contents;
  }

  append(tabId: string, data: string): void {
    const whole = (this.carries.get(tabId) ?? "") + data;
    const cut = carryFrom(whole);
    this.carries.set(tabId, whole.slice(cut));
    const text = cleanTerminalOutput(whole.slice(0, cut));
    if (text === "") {
      return;
    }
    const lines = this.lines.get(tabId) ?? [""];
    const [first, ...rest] = text.split("\n");
    lines[lines.length - 1] += first;
    for (const line of rest) {
      lines.push(line);
    }
    // Trimmed at twice the cap: trimming per chunk would shift the whole array every line.
    if (lines.length > 2 * MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES);
    }
    this.lines.set(tabId, lines);
    if (!this.shellPrinted) {
      this.shellPrinted = true;
      this.writeContext();
    }
  }

  /** A shell tab's last `count` lines, its unfinished one included; "" before any output. */
  output(tabId: string, count: number): string {
    const lines = [...(this.lines.get(tabId) ?? [""])];
    lines[lines.length - 1] += cleanTerminalOutput(this.carries.get(tabId) ?? "");
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.slice(-Math.min(count, MAX_LINES)).join("\n");
  }

  /** A closed tab's lines go with it. */
  close(tabId: string): void {
    this.lines.delete(tabId);
    this.carries.delete(tabId);
  }

  private retryLater(): void {
    if (!this.disposed && this.retryTimer === undefined) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.writeContext();
      }, WRITE_RETRY_MS);
    }
  }

  private writeContext(): void {
    // The `tet-ctl` line is always there — nothing else tells an agent about it. The shell
    // paragraph only once something ran.
    const contents = [
      "<tet_context>",
      "This note is added by TET, not written by the user.",
      "You are running inside TET. Its own settings, projects and terminal tabs are",
      "controlled with `tet-ctl` (run `tet-ctl help`) — use it when the user asks",
      "about TET itself, not for work on the repository.",
      ...(this.shellPrinted
        ? [
            "",
            `The user's shell tabs in ${this.repositoryName} are read with \`tet-ctl tabs-list\` and`,
            "`tet-ctl tabs-shell-output <tab-id>` — do so when the user asks about something they ran in a shell."
          ]
        : []),
      "</tet_context>"
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
    clearTimeout(this.retryTimer);
  }
}
