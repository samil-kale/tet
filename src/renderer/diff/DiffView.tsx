import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { ThemedToken } from "shiki/core";
import type { DiffLine, FileDiff, ImageDiff } from "../../shared/types";
import { highlightDiff } from "./diff-highlight";
import { UnfoldIcon } from "../ui/icons";

interface DiffViewProps {
  /** Whose diff this is; the view reads the file itself when a gap is opened. */
  projectId: string;
  diff: FileDiff | null;
  loading: boolean;
  /**
   * Reports both waits this view goes through — reading the diff and coloring it — so the
   * dialog's own bar can show them. It is the only place that knows when the second one is over.
   */
  onBusy: (busy: boolean) => void;
  ignoreWhitespace: boolean;
}

/** Context lines a gap was filled with, keyed by the index of the hunk header it sits above. */
type OpenedGaps = Record<number, DiffLine[]>;
const NO_GAPS: OpenedGaps = {};
const NO_TOKENS: (ThemedToken[] | undefined)[] = [];

/**
 * One style object per colour, shared by every token drawn in it: a diff holds tens of
 * thousands of tokens and a fresh `{ color }` per token per build is what made a rebuild cost.
 */
const colorStyles = new Map<string | undefined, React.CSSProperties>();
function colorStyle(color: string | undefined): React.CSSProperties {
  let style = colorStyles.get(color);
  if (!style) {
    style = { color };
    colorStyles.set(color, style);
  }
  return style;
}

/** Where the lines missing in front of a hunk header start and end, in the new file. */
function gapBefore(lines: readonly DiffLine[], index: number): { from: number; to: number } | undefined {
  const header = lines[index];
  if (header.newLine === undefined) {
    return undefined;
  }
  // The last numbered line before this header is where the file was left off; without one,
  // this is the first hunk and the gap starts at the top of the file.
  let previous = 0;
  for (let before = index - 1; before >= 0; before--) {
    const line = lines[before];
    if (line.type !== "hunk" && line.newLine !== undefined) {
      previous = line.newLine;
      break;
    }
  }
  const from = previous + 1;
  const to = header.newLine - 1;
  return to >= from ? { from, to } : undefined;
}

function ImageView({ image }: { image: ImageDiff }) {
  if (!image.before && !image.after) {
    return <div className="placeholder">Image too large to show.</div>;
  }
  // GitHub Desktop's two-up view: the committed version beside the current one, and only the
  // one that exists when the file was added or deleted.
  return (
    <div className="image-diff">
      {image.before && (
        <figure>
          <img src={image.before} alt="" />
          <figcaption>Before</figcaption>
        </figure>
      )}
      {image.after && (
        <figure>
          <img src={image.after} alt="" />
          <figcaption>After</figcaption>
        </figure>
      )}
    </div>
  );
}

// Memoized: the dialog around it re-renders with every push of its repository's changed files, and
// with the same diff there is nothing here to redo — a long file is thousands of rows.
export const DiffView = memo(function DiffView({
  projectId,
  diff,
  loading,
  onBusy,
  ignoreWhitespace
}: DiffViewProps) {
  /**
   * One token list per line of the diff, once the grammar has been loaded and run. Keyed to
   * the diff it was made for, like the gaps below: the render that first shows a new diff —
   * another file, a gap just opened — must not put the old one's tokens on the new one's lines
   * for the frame before the effect below empties them. Text from another file, for a frame.
   */
  const [colored, setColored] = useState<{ of: FileDiff | null; tokens: (ThemedToken[] | undefined)[] }>({
    of: null,
    tokens: NO_TOKENS
  });
  const [highlighting, setHighlighting] = useState(false);
  // A gap belongs to the diff it was opened in — a reload, or another file, closes it again.
  // Keyed to that diff rather than reset in an effect, so the render that first sees a new
  // diff never splices the old one's lines into it (and never starts colouring that mix).
  const [opened, setOpened] = useState<{ of: FileDiff | null; gaps: OpenedGaps }>({ of: null, gaps: NO_GAPS });
  const gaps = opened.of === diff ? opened.gaps : NO_GAPS;

  /** Where the hunk headers sit in the diff git reported, in order. */
  const hunkIndices = useMemo(
    () => (diff?.lines ?? []).flatMap((line, index) => (line.type === "hunk" ? [index] : [])),
    [diff]
  );

  /** The diff as it is on screen: what git reported, with the opened gaps filled in. */
  const shown = useMemo<FileDiff | null>(() => {
    if (!diff || gaps === NO_GAPS) {
      return diff;
    }
    const lines: DiffLine[] = [];
    diff.lines.forEach((line, index) => {
      lines.push(...(gaps[index] ?? []), line);
    });
    return { ...diff, lines };
  }, [diff, gaps]);

  // Colors arrive after the diff itself: bringing up the highlighter and its grammar is
  // asynchronous, so the diff is on screen as plain text first and repaints once. Opening a
  // gap goes through here as well, so the lines it added are colored like the rest.
  const tokens = colored.of === shown ? colored.tokens : NO_TOKENS;
  useEffect(() => {
    setHighlighting(shown !== null);
    if (!shown) {
      return;
    }
    let cancelled = false;
    void highlightDiff(shown).then((tokens) => {
      if (cancelled) {
        return;
      }
      if (tokens) {
        setColored({ of: shown, tokens });
      }
      setHighlighting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [shown]);

  // Taken back when this view goes: the dialog can be closed while the diff is still being
  // read or coloured, and a "busy" nobody is left to clear would keep the dialog's bar
  // running for the rest of the session.
  useEffect(() => {
    onBusy(loading || highlighting);
    return () => onBusy(false);
  }, [loading, highlighting, onBusy]);

  /**
   * Fills the gap in front of a hunk header with the file's own lines. Context lines are the
   * same in both versions, so the working tree holds all of them; the offset between the two
   * line numbers is whatever it is at the hunk that follows.
   */
  const openGap = useCallback(
    async (index: number, from: number, to: number): Promise<void> => {
      if (!diff) {
        return;
      }
      const header = diff.lines[index];
      const offset = (header.oldLine ?? 1) - (header.newLine ?? 1);
      const texts = await window.tet.repository.fileLines(projectId, diff.path, from, to);
      if (texts.length === 0) {
        return;
      }
      // Reading them took a moment, and in it the file on screen may have become another one —
      // or the same one reloaded. Recorded against the diff they were read for, so `index`
      // never points into a diff these lines are not from.
      setOpened((current) => ({
        of: diff,
        gaps: {
          ...(current.of === diff ? current.gaps : NO_GAPS),
          [index]: texts.map((text, line) => ({
            type: "context" as const,
            oldLine: from + line + offset,
            newLine: from + line,
            text
          }))
        }
      }));
    },
    [diff, projectId]
  );

  // Built once per diff, colouring or opened gap, not per render: the dialog sits in `App`,
  // which re-renders on every tab or repository push, and up to 5000 lines of a few spans each
  // — one per token — are far too many to rebuild for a status change in another project.
  // Elements handed back unchanged are ones React does not reconcile again.
  const rows = useMemo(() => {
    if (!diff || !shown) {
      return null;
    }
    // Hunk headers come in the same order in both lists, so counting them off is all it takes
    // to know which line of the original diff a rendered header is.
    let hunk = 0;
    let source = -1;
    return shown.lines.map((line, index) => {
      if (line.type === "hunk") {
        source = hunkIndices[hunk++];
      }
      // Copied per line: `source` is one binding shared by every closure below, and the click
      // comes long after the loop has moved it on to the last hunk.
      const at = source;
      const gap = line.type === "hunk" && !gaps[at] ? gapBefore(diff.lines, at) : undefined;
      return (
        // Keyed by position in the file rather than in the list: a gap opened above shifts every
        // index below it, which would rebuild those rows instead of moving them.
        <div key={`${line.type}:${line.oldLine ?? ""}:${line.newLine ?? ""}`} className={`diff-line ${line.type}`}>
          {gap ? (
            <button
              className="diff-unfold"
              title={`Show lines ${gap.from} to ${gap.to}`}
              onClick={() => void openGap(at, gap.from, gap.to)}
            >
              <UnfoldIcon />
            </button>
          ) : (
            <span className="diff-gutter">{line.type === "hunk" ? "" : (line.oldLine ?? "")}</span>
          )}
          <span className="diff-gutter">{line.type === "hunk" ? "" : (line.newLine ?? "")}</span>
          <span className="diff-marker">{line.type === "add" ? "+" : line.type === "del" ? "-" : ""}</span>
          <span className="diff-text">
            {tokens[index]?.map((token, position) => (
              <span key={position} style={colorStyle(token.color)}>
                {token.content}
              </span>
            )) ?? line.text}
          </span>
        </div>
      );
    });
  }, [diff, shown, gaps, tokens, hunkIndices, openGap]);

  // Empty while one is being read, and nothing that says so: the dialog's own bar under its
  // title is what reports that.
  if (loading || !diff || !shown || !rows) {
    return null;
  }

  const body = (): React.ReactNode => {
    if (diff.error) {
      // The reason went out as a notice when the diff was read; the pane only says that there
      // is nothing to show, so a message the user dismissed does not linger here.
      return <div className="placeholder">Diff unavailable.</div>;
    }
    if (diff.image) {
      return <ImageView image={diff.image} />;
    }
    if (diff.binary) {
      return <div className="placeholder">Binary file.</div>;
    }
    if (shown.lines.length === 0) {
      return (
        <div className="placeholder">
          {ignoreWhitespace ? "No changes beyond whitespace." : "No textual changes."}
        </div>
      );
    }
    return (
      <div className="diff-body">
        {rows}
        {diff.truncated && (
          <div className="placeholder">Diff truncated — open the file in your editor to see the rest.</div>
        )}
      </div>
    );
  };

  return <div className="diff-view">{body()}</div>;
});
