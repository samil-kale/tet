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
  /** Reports both waits this view goes through — reading the diff and coloring it. */
  onBusy: (busy: boolean) => void;
  ignoreWhitespace: boolean;
}

/** Context lines a gap was filled with, keyed by the index of the hunk header it sits above. */
type OpenedGaps = Record<number, DiffLine[]>;
const NO_GAPS: OpenedGaps = {};
const NO_TOKENS: (ThemedToken[] | undefined)[] = [];

/** One style object per colour, shared by every token drawn in it: a diff holds tens of
 *  thousands of tokens, and a fresh `{ color }` per token per build is what made a rebuild cost. */
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
  // Without a numbered line before this header, this is the first hunk and the gap starts at the
  // top of the file.
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
  const [overlay, setOverlay] = useState(false);
  // 0 shows the old version, 100 the new one, the middle an onion-skin overlay.
  const [blend, setBlend] = useState(50);

  if (!image.before && !image.after) {
    return <div className="placeholder">Image too large to show.</div>;
  }

  // Only a modified image has two versions to lay over each other.
  const both = Boolean(image.before && image.after);
  const showOverlay = both && overlay;

  return (
    <div className="image-diff">
      {both && (
        <div className="image-diff-modes">
          <button className={`image-diff-mode${overlay ? "" : " active"}`} onClick={() => setOverlay(false)}>
            Side by side
          </button>
          <button className={`image-diff-mode${overlay ? " active" : ""}`} onClick={() => setOverlay(true)}>
            Overlay
          </button>
          {showOverlay && (
            <label className="image-diff-blend">
              Before
              <input
                type="range"
                min={0}
                max={100}
                value={blend}
                onChange={(event) => setBlend(event.currentTarget.valueAsNumber)}
              />
              After
            </label>
          )}
        </div>
      )}
      {showOverlay ? (
        // Aligned top-left, so a size change reads as the images not covering each other.
        <div className="image-diff-stack">
          <img src={image.before} alt="" />
          <img src={image.after} alt="" style={{ opacity: blend / 100 }} />
        </div>
      ) : (
        // Two-up: the committed version beside the current one.
        <div className="image-diff-pair">
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
      )}
    </div>
  );
}

// Memoized: the dialog re-renders with every push of its repository's changed files, and a long
// file is thousands of rows.
export const DiffView = memo(function DiffView({
  projectId,
  diff,
  loading,
  onBusy,
  ignoreWhitespace
}: DiffViewProps) {
  /** One token list per line of the diff. Keyed to the diff it was made for, like the gaps below:
   *  the render that first shows a new diff must not put the old one's tokens on its lines. */
  const [colored, setColored] = useState<{ of: FileDiff | null; tokens: (ThemedToken[] | undefined)[] }>({
    of: null,
    tokens: NO_TOKENS
  });
  const [highlighting, setHighlighting] = useState(false);
  // A gap belongs to the diff it was opened in. Keyed to that diff rather than reset in an effect,
  // so the render that first sees a new diff never splices the old one's lines into it.
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

  // Colors arrive after the diff itself: the highlighter and its grammar come up asynchronously,
  // so the diff is on screen as plain text first and repaints once.
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

  // Taken back when this view goes: a "busy" nobody clears would keep the dialog's bar running.
  useEffect(() => {
    onBusy(loading || highlighting);
    return () => onBusy(false);
  }, [loading, highlighting, onBusy]);

  /** Fills the gap in front of a hunk header with the file's own lines. Context lines are the same
   *  in both versions; the offset between the two line numbers is the following hunk's. */
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
      // Recorded against the diff they were read for, the file on screen having possibly changed
      // meanwhile: `index` never points into a diff these lines are not from.
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

  // Built once per diff, colouring or opened gap, not per render: the dialog sits in `App`, which
  // re-renders on every tab or repository push, and 5000 lines of a few spans each are too many.
  const rows = useMemo(() => {
    if (!diff || !shown) {
      return null;
    }
    // Hunk headers come in the same order in both lists, so counting them off says which line of
    // the original diff a rendered header is.
    let hunk = 0;
    let source = -1;
    return shown.lines.map((line, index) => {
      if (line.type === "hunk") {
        source = hunkIndices[hunk++];
      }
      // Copied per line: `source` is one binding shared by every closure below, and a click comes
      // long after the loop moved it on to the last hunk.
      const at = source;
      const gap = line.type === "hunk" && !gaps[at] ? gapBefore(diff.lines, at) : undefined;
      return (
        // Keyed by position in the file, not in the list: a gap opened above shifts every index below
        // it, rebuilding those rows instead of moving them.
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

  // Empty while one is being read; the dialog's own bar reports that.
  if (loading || !diff || !shown || !rows) {
    return null;
  }

  const body = (): React.ReactNode => {
    if (diff.error) {
      // The reason went out as a notice when the diff was read.
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
