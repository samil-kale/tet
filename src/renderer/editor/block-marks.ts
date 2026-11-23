/** A preview's block that maps to the source: where it starts, there and in the scroller. */
export interface Mark {
  /** The block's first source line, 0-based. */
  line: number;
  /** Its offset in the scroller. */
  top: number;
}

/** The last mark `reached` holds for, and the one after it — what a position falls between.
 *  `reached` must hold for a prefix of `marks` (their lines and tops only grow), so it is found by
 *  halving. */
export function around(marks: readonly Mark[], reached: (mark: Mark) => boolean): [Mark | undefined, Mark | undefined] {
  let low = 0;
  let high = marks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (reached(marks[middle])) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return [marks[low - 1], marks[low]];
}

/** The scroller offset of the source `line` (0-based, fractional): between the marks around it, in
 *  proportion. */
export function topOfLine(marks: readonly Mark[], line: number): number {
  const [before, after] = around(marks, (mark) => mark.line <= line);
  if (!before) {
    return 0;
  }
  const share = after ? (line - before.line) / (after.line - before.line) : 0;
  return before.top + share * ((after?.top ?? before.top) - before.top);
}

/** The source line at scroller offset `top`, fractional; undefined without marks. */
export function lineOfTop(marks: readonly Mark[], top: number): number | undefined {
  const [before, after] = around(marks, (mark) => mark.top <= top);
  if (!before) {
    return marks.length > 0 ? 0 : undefined;
  }
  const height = after ? after.top - before.top : 0;
  const share = height > 0 ? (top - before.top) / height : 0;
  return before.line + share * ((after?.line ?? before.line) - before.line);
}

/**
 * The marks of a preview, measured once and kept until `invalidate`: measuring reads every block's
 * layout, which a scroll event must not do each time. The owner invalidates on a render and on any
 * size change of the preview.
 */
export class BlockMarks {
  private marks: Mark[] | undefined;

  constructor(private readonly measure: () => Mark[]) {}

  get(): readonly Mark[] {
    this.marks ??= this.measure();
    return this.marks;
  }

  invalidate(): void {
    this.marks = undefined;
  }
}
