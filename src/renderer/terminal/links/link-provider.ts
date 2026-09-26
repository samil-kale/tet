import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { isModifierHeld, isModifierKey } from "../../platform";

/**
 * Rows the search for a wrapped token may walk each way. The character budget alone cannot bound
 * it: blank isWrapped rows (a TUI's start screen) add zero, letting the walk run through the whole
 * scrollback on every render.
 */
const MAX_WINDOW_ROWS = 20;
/** Characters the same walk may gather each way. */
const MAX_WINDOW_CHARS = 2048;

interface LinkSegment {
  row: number;
  /** 0-based cell the segment starts at. */
  sx: number;
  /** 0-based cell one past its end. */
  ex: number;
}

/**
 * A regex link provider whose links are clickable, underlined and pointer-cursored only while Ctrl
 * (Cmd on macOS) is held, so the click is not taken from CLIs with their own mouse tracking.
 */
export function createModifierGatedLinkProvider(
  terminal: Terminal,
  regex: RegExp,
  /**
   * A substring every match contains. Both regexes backtrack quadratically through a 2048-char
   * space-free window (a wrapped base64 blob), every render; a linear `includes` rules it out first.
   */
  anchor: string,
  onActivate: (text: string) => void
): ILinkProvider {
  // Built once: provideLinks runs on every render while the pointer is over the terminal — nothing
  // expensive, and no logging, in that path.
  const rex = new RegExp(regex.source, (regex.flags || "") + "g");
  return {
    provideLinks(bufferLineNumber, callback) {
      callback(computeLinks(bufferLineNumber, terminal, rex, anchor, onActivate));
    }
  };
}

function computeLinks(
  y: number,
  terminal: Terminal,
  rex: RegExp,
  anchor: string,
  onActivate: (text: string) => void
): ILink[] {
  const [lines, startLineIndex, offsets] = getWindowedLineStrings(y - 1, terminal);
  const line = lines.join("");
  if (!line.includes(anchor)) {
    return [];
  }

  const result: ILink[] = [];
  let match;
  while ((match = rex.exec(line))) {
    const text = match[0];

    // Map string positions back to buffer positions (values are 0-based, right side excluding).
    const [startY, startX] = mapStrIdx(terminal, startLineIndex, offsets[0] ?? 0, match.index, startLineIndex, offsets);
    const [endY, endX] = mapStrIdx(terminal, startY, startX, text.length, startLineIndex, offsets);

    if (startY === -1 || startX === -1 || endY === -1 || endX === -1) {
      continue;
    }

    // Where the match has characters, row by row — what gets underlined.
    const segments: LinkSegment[] = [];
    for (let row = startY; row <= endY; row++) {
      const sx = row === startY ? startX : (offsets[row - startLineIndex] ?? 0);
      const ex = row === endY ? endX : rowTextEnd(terminal, row);
      // mapStrIdx reports a match ending at the right edge as the start of the row below.
      if (ex > sx) {
        segments.push({ row, sx, ex });
      }
    }
    const first = segments[0];
    if (!first) {
      continue;
    }

    // One link across all rows: xterm keeps one link per column of the queried row
    // (Linkifier._removeIntersectingLinks), dropping a per-row link's later rows. The range is
    // what's clickable, `segments` what's underlined.
    const end = segments[segments.length - 1];
    // range expects values 1-based, right side including, thus +1 except for ex.
    const range = {
      start: { x: first.sx + 1, y: first.row + 1 },
      end: { x: end.ex, y: end.row + 1 }
    };

    result.push(buildLink(terminal, range, segments, text, onActivate));
  }

  return result;
}

/** Per terminal, the `leave` of the link under the pointer — see endLinkHover. */
const hovered = new WeakMap<Terminal, () => void>();

/**
 * Ends the hover of a terminal about to be disposed: xterm's dispose calls no link's `leave`, so a
 * tab closed under the pointer (`tet-ctl tabs-close`) kept its window key listeners, and with them
 * the disposed terminal (measured).
 */
export function endLinkHover(terminal: Terminal): void {
  hovered.get(terminal)?.();
}

function buildLink(
  terminal: Terminal,
  range: ILink["range"],
  segments: LinkSegment[],
  text: string,
  onActivate: (text: string) => void
): ILink {
  let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
  let onKeyUp: ((event: KeyboardEvent) => void) | undefined;
  let underlines: HTMLElement[] = [];

  const clearUnderline = () => {
    for (const element of underlines) {
      element.remove();
    }
    underlines = [];
  };

  /**
   * xterm's own underline runs start to end across rows, gaps and wrap indents included; one rule
   * per segment sits exactly under the characters.
   *
   * Not terminal.registerDecoration(): xterm's BufferDecorationRenderer hides decorations on the
   * alternate screen, i.e. in a full-screen agent TUI. Nothing outlives the hover.
   */
  const drawUnderline = () => {
    clearUnderline();
    const screen = terminal.element?.querySelector(".xterm-screen");
    if (!(screen instanceof HTMLElement)) {
      return;
    }
    // xterm sizes the screen to exactly cols x rows cells, so dividing gives the cell size.
    const cellWidth = screen.clientWidth / terminal.cols;
    const cellHeight = screen.clientHeight / terminal.rows;
    for (const segment of segments) {
      const viewportRow = segment.row - terminal.buffer.active.viewportY;
      if (viewportRow < 0 || viewportRow >= terminal.rows) {
        continue;
      }
      const element = document.createElement("div");
      element.style.position = "absolute";
      element.style.left = `${segment.sx * cellWidth}px`;
      element.style.top = `${(viewportRow + 1) * cellHeight - 1}px`;
      element.style.width = `${(segment.ex - segment.sx) * cellWidth}px`;
      element.style.height = "1px";
      element.style.backgroundColor = "currentColor";
      // The link's range does hit testing; this must not swallow clicks.
      element.style.pointerEvents = "none";
      screen.appendChild(element);
      underlines.push(element);
    }
  };

  const leave = (): void => {
    if (hovered.get(terminal) === leave) {
      hovered.delete(terminal);
    }
    if (onKeyDown) {
      window.removeEventListener("keydown", onKeyDown);
    }
    if (onKeyUp) {
      window.removeEventListener("keyup", onKeyUp);
    }
    onKeyDown = undefined;
    onKeyUp = undefined;
    clearUnderline();
  };

  const link: ILink = {
    range,
    text,
    // The cursor shows while the modifier is held (hover()); `underline` stays off for
    // drawUnderline().
    decorations: { pointerCursor: false, underline: false },
    activate(event) {
      // A plain click belongs to the CLI's own mouse tracking.
      if (isModifierHeld(event)) {
        onActivate(text);
      }
    },
    dispose: clearUnderline,
    hover(event) {
      const setDecorations = (held: boolean) => {
        if (link.decorations) {
          link.decorations.pointerCursor = held;
        }
        if (held) {
          drawUnderline();
        } else {
          clearUnderline();
        }
      };
      // xterm calls hover() before swapping link.decorations for its proxy, discarding a sync
      // mutation; the microtask runs after.
      queueMicrotask(() => setDecorations(isModifierHeld(event)));
      onKeyDown = (e) => {
        // A held modifier auto-repeats.
        if (isModifierKey(e) && !e.repeat) {
          setDecorations(true);
        }
      };
      onKeyUp = (e) => {
        if (isModifierKey(e)) {
          setDecorations(false);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      hovered.set(terminal, leave);
    },
    leave
  };
  return link;
}

// Adapted from @xterm/addon-web-links's LinkComputer (not exported): stitches wrapped rows into
// one string and maps a match's string index back to buffer cells.
//
// Beyond xterm's soft wrap (`isWrapped`): a CLI wrapping itself (Claude Code's Ink writes a real
// newline per visual row) leaves `isWrapped` false, so `isContinuation()` also takes a row whose
// predecessor filled the last column, and `readLine()` drops such a CLI's continuation indent.

/** Whether the row at `lineIndex` continues the text of the row above it. */
function isContinuation(terminal: Terminal, lineIndex: number): boolean {
  const line = terminal.buffer.active.getLine(lineIndex);
  if (!line) {
    return false;
  }
  if (line.isWrapped) {
    return true;
  }
  const previous = terminal.buffer.active.getLine(lineIndex - 1);
  // Trimmed and still as wide as the row: it ran into the right edge.
  return !!previous && previous.translateToString(true).length >= previous.length;
}

/** Cell index one past the row's last non-blank cell. */
function rowTextEnd(terminal: Terminal, lineIndex: number): number {
  const line = terminal.buffer.active.getLine(lineIndex);
  return line ? line.translateToString(true).length : 0;
}

/** The row's text plus the cell offset that text starts at (non-zero if an indent was dropped). */
function readLine(terminal: Terminal, lineIndex: number): [string, number] {
  const line = terminal.buffer.active.getLine(lineIndex);
  if (!line) {
    return ["", 0];
  }
  const content = line.translateToString(true);
  // xterm's soft wrap adds no indent: leading spaces on an isWrapped row are content.
  if (line.isWrapped || !isContinuation(terminal, lineIndex)) {
    return [content, 0];
  }
  const unindented = content.replace(/^ +/, "");
  return [unindented, content.length - unindented.length];
}

function getWindowedLineStrings(lineIndex: number, terminal: Terminal): [string[], number, number[]] {
  let topIdx = lineIndex;
  let bottomIdx = lineIndex;
  let length: number;
  let rows: number;
  let content: string;
  let offset: number;
  const lines: string[] = [];
  const offsets: number[] = [];

  if (terminal.buffer.active.getLine(lineIndex)) {
    const [currentContent, currentOffset] = readLine(terminal, lineIndex);

    // Expand top, stop on whitespace, MAX_WINDOW_CHARS or MAX_WINDOW_ROWS.
    if (isContinuation(terminal, lineIndex) && currentContent[0] !== " ") {
      length = 0;
      rows = 0;
      // Caps checked before the step: `topIdx` never names an unread row.
      while (length < MAX_WINDOW_CHARS && rows < MAX_WINDOW_ROWS && terminal.buffer.active.getLine(topIdx - 1)) {
        topIdx--;
        rows++;
        [content, offset] = readLine(terminal, topIdx);
        length += content.length;
        lines.push(content);
        offsets.push(offset);
        if (!isContinuation(terminal, topIdx) || content.indexOf(" ") !== -1) {
          break;
        }
      }
      lines.reverse();
      offsets.reverse();
    }

    lines.push(currentContent);
    offsets.push(currentOffset);

    // Expand bottom, stop on whitespace, MAX_WINDOW_CHARS or MAX_WINDOW_ROWS.
    length = 0;
    rows = 0;
    while (
      isContinuation(terminal, bottomIdx + 1) &&
      terminal.buffer.active.getLine(++bottomIdx) &&
      length < MAX_WINDOW_CHARS &&
      ++rows <= MAX_WINDOW_ROWS
    ) {
      [content, offset] = readLine(terminal, bottomIdx);
      length += content.length;
      lines.push(content);
      offsets.push(offset);
      if (content.indexOf(" ") !== -1) {
        break;
      }
    }
  }
  return [lines, topIdx, offsets];
}

function mapStrIdx(
  terminal: Terminal,
  lineIndex: number,
  rowIndex: number,
  stringIndex: number,
  startLineIndex: number,
  offsets: number[]
): [number, number] {
  const buf = terminal.buffer.active;
  const cell = buf.getNullCell();
  let start = rowIndex;
  while (stringIndex) {
    const line = buf.getLine(lineIndex);
    if (!line) {
      return [-1, -1];
    }
    for (let i = start; i < line.length; ++i) {
      line.getCell(i, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width) {
        stringIndex -= chars.length || 1;

        // Correct stringIndex for early wrapped wide chars:
        // - currently only happens at last cell
        // - cells to the right are reset with chars='' and width=1 in InputHandler.print
        // - follow-up line must be wrapped and contain wide char at first cell
        // --> if all these conditions are met, correct stringIndex by +1
        if (i === line.length - 1 && chars === "") {
          const nextLine = buf.getLine(lineIndex + 1);
          if (nextLine && nextLine.isWrapped) {
            nextLine.getCell(0, cell);
            if (cell.getWidth() === 2) {
              stringIndex += 1;
            }
          }
        }
      }
      if (stringIndex < 0) {
        return [lineIndex, i];
      }
    }
    lineIndex++;
    // Skip the indent readLine() dropped.
    start = offsets[lineIndex - startLineIndex] ?? 0;
  }
  return [lineIndex, start];
}
