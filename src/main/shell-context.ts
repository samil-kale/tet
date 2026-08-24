import * as fs from "node:fs";
import * as path from "node:path";
import { WIN_BOM } from "./os-notify";

/** Collapses the burst of chunks a single command's output arrives in into one write. */
const WRITE_DEBOUNCE_MS = 250;
/** Under continuous output the debounce never fires; this is the longest a write is held back. */
const WRITE_MAX_WAIT_MS = 2000;
/**
 * The log lives in its own file rather than being inlined into every prompt, so it can hold
 * far more than an excerpt. A verbose producer still fills it without bound, so keep the
 * most recent slice rather than an ever-growing file.
 */
const MAX_LOG_CHARS = 500_000;
const LOG_TRUNCATION_NOTE = "... [earlier output dropped, showing most recent]\n";
// PowerShell 5.1's Get-Content decodes BOM-less files as ANSI, so on win32 the context file
// needs a UTF-8 BOM or non-ASCII output gets garbled on its way into the prompt.
const CONTEXT_FILE_BOM = process.platform === "win32" ? WIN_BOM : "";

/**
 * Replaces a file's contents without ever holding it open for writing. Everything written here
 * is read by another process — an agent's prompt hook, or the agent's own file reads — and on
 * Windows opening a file mid-write fails outright rather than returning partial data. Writing
 * beside it and renaming into place gives a reader either the previous file or the new one.
 */
async function replaceFile(file: string, contents: string): Promise<void> {
  const temp = `${file}.tmp`;
  await fs.promises.writeFile(temp, contents);
  await fs.promises.rename(temp, file);
}

/** A bounded log file, written only when its contents actually changed. */
class CappedLogFile {
  private content = "";
  private truncated = false;
  private dirty = false;
  /** Writes are chained rather than started concurrently — they share one temp path. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  get chars(): number {
    return this.content.length;
  }

  append(text: string): void {
    this.content += text;
    // Trimmed at twice the cap here and to the cap in flush(): a slice copies the whole buffer,
    // and doing that per chunk once the log is full — a build produces thousands — is half a
    // megabyte of copying per pty read on the main thread.
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
        // Nothing landed on disk, so the next flush has to try again.
        this.dirty = true;
      });
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Terminal data arrives raw. Escape sequences mean nothing in a log file, and a progress bar
 * redraws its line with a bare carriage return — keeping only what follows the last one
 * leaves each line as the terminal finally showed it, instead of one line per redraw.
 */
function cleanTerminalOutput(data: string): string {
  return data
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

// eslint-disable-next-line no-control-regex
const ANSI_AT_START = /^(?:\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/;
/** How much of a chunk may be held back for the next one before it counts as never ending. */
const MAX_CARRY = 4096;

/**
 * Where a chunk has to be cut so that what `cleanTerminalOutput` acts on is whole: pty reads
 * end anywhere, and a chunk ending in the `\r` of a `\r\n` would lose its whole line to the
 * carriage-return rule, while an escape sequence split in two would leave both halves in the
 * log. Everything from that point on waits for the next chunk.
 *
 * A line still being written waits whole, up to that same limit: a progress bar redrawn with
 * `\r` across a chunk boundary would otherwise leave both drawings in the log, the very thing
 * the carriage-return rule is there to prevent. (A `\r` at the very end is that case too.)
 */
function carryFrom(data: string): number {
  const newline = data.lastIndexOf("\n");
  if (data.length - newline - 1 < MAX_CARRY) {
    return newline + 1;
  }
  const escape = data.lastIndexOf("\x1b");
  if (escape !== -1 && data.length - escape < MAX_CARRY && !ANSI_AT_START.test(data.slice(escape))) {
    return escape;
  }
  return data.length;
}

/**
 * What tet tells an agent about the repository it is working in: the running transcript of
 * the shell tabs the user opened next to it. Modelled on how the VS Code extension passed a
 * debug session's console output — a capped file the agent is pointed at and reads on demand,
 * not an excerpt inlined into every prompt.
 *
 * Only shell tabs feed it. An agent tab's output is its TUI redrawing itself, and handing
 * that back to the agent that produced it is noise at best.
 *
 * Every shell tab of a project writes into the one file, in the order the output arrived. So
 * a build in one tab and a `git log` in another do interleave — but never mid-line (each tab
 * keeps its own unfinished line back) and never unmarked: a header names the tab wherever the
 * writer changes, so a reader can tell whose output a section is.
 */
export class ShellContext {
  private readonly log: CappedLogFile;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set on the first append after a flush; the latest the next flush may come. */
  private flushDeadline: number | undefined;
  /** What was last written, so an unchanged context isn't rewritten on every burst. */
  private written: string | undefined;
  /** Writes are chained rather than started concurrently — they share one temp path. */
  private writing: Promise<void> = Promise.resolve();
  /** Per tab, the end of its last chunk that could not be cleaned until the next one arrives. */
  private readonly carries = new Map<string, string>();
  /** The tab whose output the log currently ends in; any other tab opens a new section. */
  private lastWriter: string | undefined;

  constructor(
    private readonly directory: string,
    private readonly repositoryName: string
  ) {
    fs.mkdirSync(directory, { recursive: true });
    this.log = new CappedLogFile(this.logFile);
    // Written up front so the agent's hook has something to read before the first output
    // ever arrives — an absent file would make the hook fail rather than say nothing.
    this.writeContext();
  }

  get logFile(): string {
    return path.join(this.directory, "shell-output.log");
  }

  get contextFile(): string {
    return path.join(this.directory, "context.md");
  }

  /** `label` is what a section header calls the tab — its title, or its id where it has none. */
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
      // On a line of its own, so a plain search finds it and it reads apart from the
      // program output either side of it.
      this.log.append(`${this.log.chars === 0 ? "" : "\n"}=== shell tab: ${label} ===\n`);
    }
    this.log.append(text);
    // Debounced, but no further than the deadline: a build or a `tail -f` never pauses long
    // enough for the debounce alone, and a file that is only ever written once the output
    // stops is one the agent can't read while the user is asking about it.
    const now = Date.now();
    this.flushDeadline ??= now + WRITE_MAX_WAIT_MS;
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(
      () => {
        this.flushDeadline = undefined;
        this.log.flush();
        this.writeContext();
      },
      Math.min(WRITE_DEBOUNCE_MS, Math.max(0, this.flushDeadline - now))
    );
  }

  private writeContext(): void {
    // The `tet-ctl` line is there from the first prompt on: nothing else tells an agent that
    // the app around it can be asked anything (see src/main/control-server.ts). The shell
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
    if (contents === this.written) {
      return;
    }
    this.written = contents;
    this.writing = this.writing
      .then(() => replaceFile(this.contextFile, CONTEXT_FILE_BOM + contents))
      .catch((error) => {
        console.error("[tet] failed to write the context file:", error);
        // Nothing landed on disk, so the next write must not be skipped as unchanged.
        this.written = undefined;
      });
  }

  dispose(): void {
    for (const tabId of [...this.carries.keys()]) {
      this.close(tabId);
    }
    clearTimeout(this.writeTimer);
    this.log.flush();
  }
}
