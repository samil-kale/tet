/** What the annotate mode keeps and says, apart from xterm: pure, so a test needs no terminal. */

export type AnnotationKind = "good" | "comment" | "delete";

/**
 * Buffer coordinates as xterm's `getSelectionPosition` gives them: rows absolute (scrollback
 * included, from 0), columns from 0, the end column exclusive.
 */
export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface Annotation {
  /** Identity across removals; the number a view shows is the position in the list. */
  id: number;
  kind: AnnotationKind;
  /** The marked text as `textOfRange` read it, whitespace collapsed. */
  text: string;
  /** Set for a `comment`. */
  comment?: string;
  range: CellRange;
  /** The buffer the range lies in: the alternate screen's rows are not the normal buffer's. */
  buffer: "normal" | "alternate";
}

/** The part of a row a range covers. */
export interface RowSegment {
  row: number;
  startCol: number;
  endCol: number;
}

/** The slice of xterm's `IBufferLine` and `IBuffer` that `textOfRange` reads. */
export interface RangeSource {
  getLine(row: number): { translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string } | undefined;
}

export function rowSegments(range: CellRange, cols: number): RowSegment[] {
  const segments: RowSegment[] = [];
  for (let row = range.startRow; row <= range.endRow; row++) {
    const startCol = row === range.startRow ? range.startCol : 0;
    const endCol = row === range.endRow ? range.endCol : cols;
    if (endCol > startCol) {
      segments.push({ row, startCol, endCol });
    }
  }
  return segments;
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  if (row < range.startRow || row > range.endRow) {
    return false;
  }
  if (row === range.startRow && col < range.startCol) {
    return false;
  }
  return row !== range.endRow || col < range.endCol;
}

/** The annotation covering a cell; of several, the latest, which lies on top. */
export function annotationAt(annotations: readonly Annotation[], row: number, col: number): Annotation | undefined {
  for (let index = annotations.length - 1; index >= 0; index--) {
    if (rangeContains(annotations[index].range, row, col)) {
      return annotations[index];
    }
  }
  return undefined;
}

/** The range's text, its rows joined by a space and every run of whitespace collapsed to one. */
export function textOfRange(source: RangeSource, range: CellRange): string {
  const rows: string[] = [];
  for (let row = range.startRow; row <= range.endRow; row++) {
    const startCol = row === range.startRow ? range.startCol : 0;
    const endCol = row === range.endRow ? range.endCol : undefined;
    rows.push(source.getLine(row)?.translateToString(true, startCol, endCol) ?? "");
  }
  return rows.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Where the text of a range went, once the program redrew: the same rows and columns, moved up or
 * down by the fewest rows. Undefined where it stands nowhere. A program that clears the screen and
 * prints again, or grows its input, moves its text this way; one that wraps it differently does not
 * leave it findable.
 */
export function relocateRange(source: RangeSource, length: number, range: CellRange, text: string): CellRange | undefined {
  const height = range.endRow - range.startRow;
  for (let distance = 1; distance < length; distance++) {
    let inside = false;
    for (const delta of [distance, -distance]) {
      const startRow = range.startRow + delta;
      if (startRow < 0 || startRow + height >= length) {
        continue;
      }
      inside = true;
      const moved = { ...range, startRow, endRow: startRow + height };
      if (textOfRange(source, moved) === text) {
        return moved;
      }
    }
    if (!inside) {
      return undefined;
    }
  }
  return undefined;
}

/** What the menu and the popup call an annotation of this kind; the feedback says it in lower case. */
export const KIND_LABELS: Record<AnnotationKind, string> = { good: "Looks Good", comment: "Comment", delete: "Delete" };

/** The feedback typed into the agent's prompt: one numbered line per annotation, in the order made. */
export function formatFeedback(annotations: readonly Annotation[]): string {
  const lines = annotations.map((annotation, index) => {
    const head = `${index + 1} (${KIND_LABELS[annotation.kind].toLowerCase()}) "${annotation.text}"`;
    return annotation.comment === undefined ? head : `${head}: ${annotation.comment}`;
  });
  return `Annotations on your output\n\n${lines.join("\n")}`;
}

/** xterm's mouse reporting, as `term.modes.mouseTrackingMode` names it. */
export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";

const TRACKING_PARAMS: Record<number, Exclude<MouseTracking, "none">> = { 9: "x10", 1000: "vt200", 1002: "drag", 1003: "any" };

/** Every reporting mode at once, in ascending order as an object's integer keys come. */
const ALL_TRACKING = Object.keys(TRACKING_PARAMS).join(";");

/**
 * Switches the mouse reporting off in xterm alone, so it selects text where a TUI had taken the
 * mouse. One sequence, which `trackingAfter` knows again as its own: the focus and encoding modes
 * stay.
 */
export const MOUSE_TRACKING_OFF = `\x1b[?${ALL_TRACKING}l`;

/** Whether a private-mode sequence names a mouse reporting mode. */
export function touchesTracking(params: readonly number[]): boolean {
  return params.some((param) => param in TRACKING_PARAMS);
}

/** The sequence that puts a mode back. */
export function mouseTrackingOn(mode: MouseTracking): string {
  const param = Object.entries(TRACKING_PARAMS).find(([, name]) => name === mode)?.[0];
  return param === undefined ? "" : `\x1b[?${param}h`;
}

/**
 * What the program wants after a private-mode set (`h`) or reset (`l`) of `params`, from what it
 * wanted before; our own `MOUSE_TRACKING_OFF` is no wish of the program's.
 */
export function trackingAfter(wanted: MouseTracking, params: readonly number[], set: boolean): MouseTracking {
  if (!set && params.join(";") === ALL_TRACKING) {
    return wanted;
  }
  let next = wanted;
  for (const param of params) {
    const name = TRACKING_PARAMS[param];
    if (name !== undefined) {
      next = set ? name : "none";
    }
  }
  return next;
}
