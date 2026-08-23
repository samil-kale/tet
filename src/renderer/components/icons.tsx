import type { NoticeSeverity } from "../../shared/types";

export interface IconProps {
  className?: string;
}

/**
 * The share of its box a finished icon's drawing covers. Every icon is cut to this, so the box
 * an icon is given is finally the same thing as the size it appears at.
 */
const TARGET_EXTENT = 12.8;
const GRID = 16;

/**
 * How an icon is fitted, given how much of its own grid it actually draws on.
 *
 * The problem this solves: a box is not a size. Measured with `getBBox`, the icons in this file
 * covered anywhere from 59% of their grid (the chevron) to 100% (Claude's mark), so identical
 * `width`s produced visibly different icons — which is exactly what kept being reported as one
 * of them being too big. Rather than redraw two dozen paths, each declares the extent it was
 * measured at, and the viewBox is cropped to put that extent at TARGET_EXTENT of the box.
 *
 * `strokeWidth` is scaled by the same factor, or a cropped viewBox would thicken the stroke of
 * every icon it enlarges — the drawings would match and their weights would not.
 *
 * The extents are tuned to the icon's **geometric mean**, not its longer side. Normalising the
 * long side alone left the lopsided ones looking small next to the square ones — a shape 12
 * wide and 9 tall carries far less ink than one 12 by 12 — and that is what the branch icon,
 * the sync arrows, the sparkle and Claude's mark were all reported for. Each is capped at about
 * 87% of its box in the long axis: a chevron or a row of dots is narrow by nature and must not
 * grow out of its place trying to average out.
 *
 * Re-measure when a path changes; the numbers are observations, not intentions. The audit is a
 * page that renders every icon and reads `getBBox()` on each child, grown by half a stroke.
 */
function geometry(extent: number, cx: number, cy: number, grid: number, stroke: number) {
  const side = (extent * grid) / ((TARGET_EXTENT / GRID) * grid);
  return {
    viewBox: `${cx - side / 2} ${cy - side / 2} ${side} ${side}`,
    strokeWidth: (stroke * side) / grid
  };
}

/** The same fitting for an icon that brings its own grid — see agent-icons.tsx. */
export function fitIcon(extent: number, cx: number, cy: number, grid: number, stroke = 0): string {
  return geometry(extent, cx, cy, grid, stroke).viewBox;
}

export function fitStroke(extent: number, grid: number, stroke: number): number {
  return geometry(extent, 0, 0, grid, stroke).strokeWidth;
}

/**
 * How much smaller than the rest an icon is drawn when it asks to be. Two pixels off the shared
 * `--icon-size`, as a ratio so it holds whatever that size is set to. The box does not change —
 * only the drawing inside it — so nothing shifts in the row around it.
 */
export const SMALLER = 11 / 13;

/** The same two pixels the other way, for an icon that asks to read larger — see agent-icons.tsx. */
export const LARGER = 15 / 13;

/**
 * `extent` is how much of the 16 grid this icon draws on, stroke included, and `cx`/`cy` where
 * that drawing is centred. All three are measured.
 *
 * `scale` is the one number here that is a *choice* rather than an observation: it says this
 * icon should read smaller than its neighbours. Keeping it separate is the point — a measured
 * extent stays re-measurable, and an intention stays visible as one.
 */
function Svg({
  children,
  className,
  extent = TARGET_EXTENT,
  cx = 8,
  cy = 8,
  scale = 1
}: IconProps & {
  children: React.ReactNode;
  extent?: number;
  cx?: number;
  cy?: number;
  scale?: number;
}) {
  // Dividing widens the crop, which leaves the drawing smaller inside an unchanged box.
  const { viewBox, strokeWidth } = geometry(extent / scale, cx, cy, GRID, 1.5);
  return (
    <svg
      className={className}
      // The shared icon size, and the same one `--icon-size` states in CSS. It is CSS that
      // actually decides — a flex container renders over these attributes (see .icon-button) —
      // so this is the fallback for a site that forgot to, and it must not disagree with it.
      width="13"
      height="13"
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.58}>
      <path d="M8 2v12M2 8h12" />
    </Svg>
  );
}

/** Drawn smaller than the rest: it closes what it sits on, and never leads a row. */
export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.22} scale={SMALLER}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </Svg>
  );
}

/**
 * The three shapes VS Code uses for a notification: a cross for an error, an exclamation for a
 * warning, an "i" for information — each in the circle they share, so a glance at the outline
 * alone does not have to carry the meaning that the color does.
 */
export function SeverityIcon({ severity, ...props }: IconProps & { severity: NoticeSeverity }) {
  return (
    <Svg {...props} extent={13.58}>
      <circle cx="8" cy="8" r="6" />
      {severity === "error" && <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />}
      {severity === "warning" && <path d="M8 4.6v4.2M8 11.1v.4" />}
      {severity === "info" && <path d="M8 7.4v4M8 4.9v.4" />}
    </Svg>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.54}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7v.5a3 3 0 0 1-3 3H6" />
    </Svg>
  );
}

/**
 * The official Git logomark (git-scm.com/downloads/logos, Git-Icon-Black.svg), vendored and
 * recoloured to `currentColor` rather than redrawn — the same treatment as Claude's mark in
 * agent-icons.tsx. Measured in the file's own 78-unit viewBox with its `transform` applied: the
 * rotated square's bbox is a square of side 82.02 centred at (39, 39). Drawn `LARGER`, like
 * Claude's mark: dividing the measured extent tightens the crop, so the glyph grows inside a box
 * that stays the shared one and nothing beside it moves.
 */
export function GitIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(82.02 / LARGER, 39, 39, 78)}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        transform="translate(10 10) rotate(-45 29 29)"
        d="M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z"
      />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.79} cx={8.25} cy={8.25}>
      <circle cx="7" cy="7" r="3.5" />
      <path d="M9.6 9.6L13 13" />
    </Svg>
  );
}

export function ChevronIcon({ expanded, scale, ...props }: IconProps & { expanded: boolean; scale?: number }) {
  return (
    <Svg {...props} extent={8.34} scale={scale}>
      {expanded ? <path d="M4 6l4 4 4-4" /> : <path d="M6 4l4 4-4 4" />}
    </Svg>
  );
}

/**
 * A ring with a gap in it, which only reads as progress while it turns — pair it with the
 * `spinning` class. Takes the place of the icon whose action is running.
 *
 * The dash pattern is the circumference: 2π·5 ≈ 31, an arc of 23 and a gap of 8. Re-cut it
 * whenever the radius moves, or the gap changes width along with it.
 */
export function SpinnerIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.34}>
      <circle cx="8" cy="8" r="5" strokeDasharray="23 8" />
    </Svg>
  );
}

/**
 * Two sparkles, the mark every tool puts on "a model worked this out for you". Filled: at this
 * size the outline of a four-pointed star is mostly its own stroke.
 */
export function SparkleIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.6} cx={8.1} cy={7.6}>
      <path d="M6.6 2.6L8.1 6.8 12.3 8.3 8.1 9.8 6.6 14 5.1 9.8 0.9 8.3 5.1 6.8z" fill="currentColor" stroke="none" />
      <path d="M12.7 1.2L13.4 3.1 15.3 3.8 13.4 4.5 12.7 6.4 12 4.5 10.1 3.8 12 3.1z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * Filled, not outlined: at this size a hollow triangle reads as a stray corner. Drawn smaller
 * than the rest — a solid shape carries more weight than an outline of the same measurement.
 */
export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props} extent={9.6} cx={8.6} scale={SMALLER}>
      <path d="M4.5 2.8l8.2 5.2-8.2 5.2z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A tag: the label on a string that git's own icon sets draw for one. */
export function TagIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.9} cx={8.14} cy={8.24}>
      <path d="M2.5 7.7V3a.5.5 0 0 1 .5-.5h4.7a1 1 0 0 1 .7.3l5.1 5.1a1 1 0 0 1 0 1.4l-4.4 4.4a1 1 0 0 1-1.4 0L2.8 8.4a1 1 0 0 1-.3-.7z" />
      <circle cx="5.6" cy="5.6" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * A commit: a node on the line of history, VS Code's own git-commit glyph. Wide and flat, so
 * the extent is the long-side cap rather than the geometric mean (14.5 by 7.5 with stroke).
 */
export function CommitIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.33}>
      <circle cx="8" cy="8" r="3" />
      <path d="M1.5 8H5" />
      <path d="M11 8h3.5" />
    </Svg>
  );
}

/** A stash: work set aside in a box, the way an inbox tray is drawn. */
export function StashIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.54} cy={8.5}>
      <path d="M2 9.5l1.8-5A1 1 0 0 1 4.8 4h6.4a1 1 0 0 1 1 .5L14 9.5" />
      <path d="M2 9.5h3.2l.8 1.6h4l.8-1.6H14v2A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Svg>
  );
}

/**
 * Throwing local changes away. A bin rather than VS Code's discard mark, which is the refresh
 * arrow turned the other way and reads as one at a glance. It also says what happens: a file
 * git does not track goes to the system trash, not away. Next to the stash box, the pair reads
 * as "put away" and "throw away".
 */
export function DiscardIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.75} cy={8.25}>
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M4 4.5l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4.5" />
    </Svg>
  );
}

/** What is waiting to be pushed, and the button that pushes it. */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.81}>
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </Svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.81}>
      <path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" />
    </Svg>
  );
}

/** Fetch: the two arrows chasing each other that every git client draws for it. */
export function SyncIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.68}>
      <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9" />
      <path d="M12 1.5v3h-3M4 14.5v-3h3" />
    </Svg>
  );
}

/** Two arrows pushed apart, VS Code's own "unfold" — the lines hidden in a gap. */
export function UnfoldIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.94}>
      <path d="M5.5 5L8 2.5 10.5 5M5.5 11l2.5 2.5L10.5 11M3 8h10" />
    </Svg>
  );
}

/**
 * The whitespace toggle: the row of dots an editor puts where the spaces are. A paragraph mark
 * was the first try and is unreadable at this size — too much line in too little room.
 */
export function WhitespaceIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.08}>
      <circle cx="3.6" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * A session stopped mid-turn on a question nobody has answered — on its tab and on its
 * project's row. A question mark rather than a second bubble: it stands next to the bubble and
 * the spinner in the one slot each of those uses, so the three have to be told apart at a
 * glance, and both things that raise it (a permission prompt, an `AskUserQuestion`) are
 * literally questions.
 */
export function QuestionIcon(props: IconProps) {
  return (
    <Svg {...props} extent={9.32} cx={8.05} cy={7.45}>
      <path d="M5.35 5.5a2.7 2.7 0 1 1 2.7 2.85v1.35" />
      <circle cx="8.05" cy="12.15" r="0.35" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * A tab whose agent cannot start at all — sits in the same mark slot as the question mark and
 * the spinner, so it is drawn in the same family of shape, not a circle-and-cross like a
 * `SeverityIcon`. Its own color, not `--vscode-focusBorder`: see `.session-mark-error`.
 */
export function ExclamationIcon(props: IconProps) {
  return (
    <Svg {...props} extent={9.95} cy={7.86}>
      <path d="M8 3.2v6.3" />
      <circle cx="8" cy="12.1" r="0.42" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A session answered and nobody has looked yet — on its tab and on its project's row. */
export function CommentIcon(props: IconProps) {
  return (
    <Svg {...props} extent={10.22} cy={7.5}>
      <path d="M3.5 3h9v6.5H7L4.5 12V9.5h-1z" />
    </Svg>
  );
}

export function RemoteIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.34}>
      <circle cx="8" cy="8" r="5" />
      <path d="M3 8h10M8 3c1.5 1.7 1.5 8.3 0 10M8 3c-1.5 1.7-1.5 8.3 0 10" />
    </Svg>
  );
}

/**
 * The settings, beside the layout picker. Six teeth rather than the eight a gear usually has: at
 * this size the flanks of eight sit less than a stroke width apart and fill in, so what is left
 * of the drawing is a disc with a bumpy edge. The outline is straight segments only, so its box
 * is exactly its vertices' span — 2.2 to 13.8 on both axes — plus one stroke width: 13.1.
 */
export function GearIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.1}>
      <path d="M6.23 4.03 L6.45 2.2 L9.55 2.2 L9.77 4.03 L10.56 4.48 L12.24 3.76 L13.8 6.45 L12.33 7.55 L12.33 8.45 L13.8 9.55 L12.24 12.24 L10.56 11.52 L9.77 11.97 L9.55 13.8 L6.45 13.8 L6.23 11.97 L5.44 11.52 L3.76 12.24 L2.2 9.55 L3.67 8.45 L3.67 7.55 L2.2 6.45 L3.76 3.76 L5.44 4.48Z" />
      <circle cx="8" cy="8" r="2.2" />
    </Svg>
  );
}

/**
 * The five split-layout presets: a rounded frame plus whatever dividers a preset adds — the same
 * shape as the reference mockup's own preview tiles. All five share one frame and one `extent`,
 * so they read as one family. Run through the `getBBox` audit: the frame measures 14.5 by 11.5
 * with its stroke, and — wide and flat like `CommitIcon` — takes the long-side cap rather than
 * the geometric mean, same formula, same result shape: 13.33.
 */
export function LayoutSingleIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.33} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
    </Svg>
  );
}

export function LayoutCols2Icon(props: IconProps) {
  return (
    <Svg {...props} extent={13.33} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </Svg>
  );
}

export function LayoutCols3Icon(props: IconProps) {
  return (
    <Svg {...props} extent={13.33} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M5.83 3v10M10.17 3v10" />
    </Svg>
  );
}

export function LayoutSplitRightIcon(props: IconProps) {
  return (
    <Svg {...props} extent={13.33} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M8 3v10M8 8h6.5" />
    </Svg>
  );
}

export function LayoutGrid2x2Icon(props: IconProps) {
  return (
    <Svg {...props} extent={13.33} cx={8} cy={8}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M8 3v10M1.5 8h13" />
    </Svg>
  );
}

/** Browsing the repository's files — two overlapping pages, the front one folded at the corner. */
export function FilesIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.99} cx={8} cy={8.5}>
      <path d="M6 3h4l3 3v8H6z" />
      <path d="M10 3v3h3" />
      <path d="M4 5H3v9h6" />
    </Svg>
  );
}

/** The EXPLORER header's own "New File...": Lucide's `file-plus` (lucide.dev, ISC — a Feather
 *  Icons fork drawn in the same monoline-stroke language as the rest of this file), vendored on
 *  its own native 24-unit grid rather than rescaled into this file's 16-unit one: `fitIcon`/
 *  `fitStroke` take the grid as a parameter for exactly this, so a vendored icon keeps its own
 *  coordinates and still crops through the shared formula. Measured via `getBBox`, stroke
 *  included: the page is narrow enough (18 by 22) that its geometric mean would clip the bottom,
 *  so extent is the long-axis cap instead, same 0.87 formula as `CommitIcon`: 20.23, centered at
 *  (12, 12). */
export function NewFileIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20.23, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20.23, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9 15h6" />
      <path d="M12 18v-6" />
    </svg>
  );
}

/** The EXPLORER header's own "New Folder...", next to `NewFileIcon` — Lucide's `folder-plus`,
 *  vendored the same way. Measured via `getBBox`: 22 by 19, close enough to square that the
 *  geometric mean needs no cap: extent 20.45, centered at (12, 11.5). */
export function NewFolderIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20.45, 12, 11.5, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20.45, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 10v6" />
      <path d="M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

/** "Collapse Folders in Explorer": Lucide's `chevrons-up` — two stacked upward chevrons, the
 *  usual "collapse a tree" glyph (mirrors `chevrons-down` for "expand all"), replacing a
 *  hand-traced two-panes-and-a-minus that read muddier at this size than a plain chevron pair.
 *  Measured via `getBBox`: 12 by 14, extent 12.96, centered at (12, 12). */
export function CollapseAllIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(12.96, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(12.96, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m17 11-5-5-5 5" />
      <path d="m17 18-5-5-5 5" />
    </svg>
  );
}

/** The diff dialog's Diff/Edit toggle. */
export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12} cx={8.25} cy={7.75}>
      <path d="M11.5 2.5l2 2L5 13H3v-2z" />
      <path d="M9.5 4.5l2 2" />
    </Svg>
  );
}

/** Saving the file open in the editor — a floppy disk, GitHub Desktop's own shorthand for it. */
export function SaveIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.25} cx={8.25} cy={8}>
      <path d="M3 2.5h8.5l2 2V13.5H3z" />
      <path d="M5 2.5v3.5h5V2.5" />
      <path d="M5 13.5v-4h6v4" />
    </Svg>
  );
}

/**
 * A file's language, in Explorer.tsx's twistie slot — one per grammar `diff-highlight.ts`
 * bundles, so a file only ever gets a mark for a language the diff view itself can colour.
 *
 * Vendored from Catppuccin Icons' `css-variables` set (github.com/catppuccin/vscode-icons,
 * MIT — Copyright (c) 2023 Catppuccin, Copyright (c) 2023 thang-nm), the one icon theme found
 * that already draws in this file's own shape: monoline strokes on a 16x16 grid, not the filled
 * flat-colour art most VS Code icon themes use. Left at that native size rather than run through
 * `Svg`'s extent-cropping above — that system exists to normalise *our own* hand-drawn icons,
 * which never shared a canvas to begin with; this set already did, and cropping it again would
 * undo exactly the consistency it was taken for. Every per-path `stroke="var(--vscode-ctp-*)"`
 * in the original is dropped in favour of inheriting this wrapper's own `currentColor`, which is
 * the one edit that makes a deliberately multi-colour set monochrome.
 */
function LangSvg({
  className,
  viewBox = "0 0 16 16",
  children
}: IconProps & { viewBox?: string; children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function CIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="m 4.0559072,12.951629 c 2.7459832,2.734744 7.1981158,2.734744 9.9441188,0 l -1.789955,-1.782586 c -1.75742,1.750224 -4.6067879,1.750224 -6.3642294,0 -1.7574416,-1.7502236 -1.7574416,-4.587893 0,-6.338097 1.7574415,-1.750224 4.6068094,-1.750224 6.3642294,0 l 0.894977,-0.8912929 0.894978,-0.891293 c -2.746003,-2.73472867 -7.1981359,-2.73472867 -9.944119,0 -2.7459858,2.7347089 -2.7459858,7.1685599 2e-7,9.9032689 z"
      />
    </LangSvg>
  );
}

export function CppIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="m 2.5559121,12.951629 c 2.7459832,2.734744 7.1981158,2.734744 9.9441189,0 l -1.789955,-1.782586 c -1.7574201,1.750224 -4.606788,1.750224 -6.3642295,0 -1.7574416,-1.7502236 -1.7574416,-4.587893 0,-6.338097 1.7574415,-1.750224 4.6068094,-1.750224 6.3642295,0 l 0.894977,-0.8912929 0.894978,-0.891293 c -2.7460031,-2.73472867 -7.198136,-2.73472867 -9.9441191,0 -2.74598585,2.7347089 -2.74598585,7.1685599 2e-7,9.9032689 z"
      />
      <path d="M7.5 6v4M5.513524 7.9999996H9.51304M13.486476 5.9999996v4M11.5 7.9999992h3.999516" />
    </LangSvg>
  );
}

export function CSharpIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="m 6.665625,1.0107144 c 0.54375,0.090628 0.9125,0.6062693 0.821875,1.1500367 L 7.18125,3.9983098 h 2.971875 L 10.5125,1.8326156 c 0.09063,-0.5437673 0.60625,-0.9125291 1.15,-0.8219012 0.54375,0.090628 0.9125,0.6062693 0.821875,1.1500367 L 12.18125,3.9983098 H 14 c 0.553125,0 1,0.4468892 1,1.0000319 0,0.5531426 -0.446875,1.0000319 -1,1.0000319 H 11.846875 L 11.18125,9.9985013 H 13 c 0.553125,0 1,0.4468897 1,1.0000317 0,0.553143 -0.446875,1.000032 -1,1.000032 H 10.846875 L 10.4875,14.164259 c -0.09063,0.543768 -0.60625,0.912529 -1.15,0.821902 -0.54375,-0.09063 -0.9125,-0.60627 -0.821875,-1.150037 l 0.30625,-1.834434 h -2.975 L 5.4875,14.167384 c -0.090625,0.543768 -0.60625,0.91253 -1.15,0.821902 C 3.79375,14.898658 3.425,14.383016 3.515625,13.839249 L 3.81875,11.998565 H 2 c -0.553125,0 -1,-0.446889 -1,-1.000032 C 1,10.445391 1.446875,9.9985013 2,9.9985013 H 4.153125 L 4.81875,5.9983736 H 3 c -0.553125,0 -1,-0.4468893 -1,-1.0000319 C 2,4.445199 2.446875,3.9983098 3,3.9983098 H 5.153125 L 5.5125,1.8326156 C 5.603125,1.2888483 6.11875,0.9200865 6.6625,1.0107144 Z M 6.846875,5.9983736 6.18125,9.9985013 H 9.153125 L 9.81875,5.9983736 Z" />
    </LangSvg>
  );
}

export function CssIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="m4 1.5h8c1.38 0 2.5 1.12 2.5 2.5v8c0 1.38-1.12 2.5-2.5 2.5h-8c-1.38 0-2.5-1.12-2.5-2.5v-8c0-1.38 1.12-2.5 2.5-2.5z" />
      <path
        strokeWidth=".814"
        d="m 10.240861,11.529149 c 0,0.58011 0.437448,1.039154 0.96002,1.035371 l 0.451635,-0.0032 c 0.522572,-0.0036 0.949379,-0.451477 0.949379,-1.032848 0,-0.581372 -0.426807,-1.065638 -0.949379,-1.065638 l -0.451635,3.4e-5 c -0.522572,3.9e-5 -0.949379,-0.4855273 -0.949379,-1.0656374 0,-0.5801104 0.426807,-1.0378931 0.949379,-1.0378931 l 0.451635,2.825e-4 c 0.522572,3.267e-4 0.951743,0.4577827 0.951743,1.0378931 M 6.8003972,11.529149 c 0,0.58011 0.4374474,1.039154 0.9600196,1.035371 l 0.46464,-0.0032 c 0.5225722,-0.0035 0.9363738,-0.451477 0.9363738,-1.031587 0,-0.580111 -0.4090724,-1.065638 -0.9316446,-1.065638 l -0.4693692,3.4e-5 c -0.5225722,3.8e-5 -0.949379,-0.4855272 -0.949379,-1.0656373 0,-0.5801104 0.4268068,-1.0378931 0.949379,-1.0378931 h 0.4516348 c 0.5225722,0 0.9635665,0.4577827 0.9635665,1.0378931 M 3.4072246,11.529149 c 0,0.58011 0.4374474,1.051765 0.9600196,1.051765 H 4.818879 c 0.5225722,0 0.949379,-0.456521 0.949379,-1.037893 m 0.01129,-2.1312747 c 0,-0.5801103 -0.4374474,-1.037893 -0.9600196,-1.037893 L 4.3678939,8.3741358 C 3.8453217,8.3744624 3.4078743,8.8420074 3.4078743,9.4233788 v 2.1186642"
      />
    </LangSvg>
  );
}

export function GoIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="m15.48 8.06-4.85.48m4.85-.48a4.98 4.98 0 01-4.54 5.42 5 5 0 112.95-8.66l-1.7 1.84a2.5 2.5 0 00-4.18 2.06c.05.57.3 1.1.69 1.51.25.27 1 .83 1.78.82.8-.02 1.58-.25 2.07-.81 0 0 .8-.96.68-1.88M2.5 8.5l-2 .01m1.5 2h1.5m-2-3.99 2-.02" />
    </LangSvg>
  );
}

export function HtmlIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M1.5 1.5h13L13 13l-5 2-5-2z" />
      <path d="M11 4.5H5l.25 3h5.5l-.25 3-2.5 1-2.5-1-.08-1" />
    </LangSvg>
  );
}

/** Catppuccin files this under "properties" — INI's own file kind, just not its own name. */
export function IniIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M8 1.5c-.87 0-1.17 1.32-2.03 1.63-.86.3-2.17-.68-2.84 0-.68.67.3 1.98 0 2.84S1.5 7.13 1.5 8s1.32 1.17 1.63 2.03c.3.86-.68 2.17 0 2.85.67.67 1.98-.3 2.84 0 .85.3 1.16 1.62 2.03 1.62s1.17-1.32 2.03-1.63c.86-.3 2.17.68 2.85 0 .67-.67-.3-1.98 0-2.84.3-.85 1.62-1.16 1.62-2.03s-1.32-1.17-1.63-2.03c-.3-.86.68-2.17 0-2.84-.67-.68-1.98.3-2.84 0S8.87 1.5 8 1.5m0 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5" />
    </LangSvg>
  );
}

export function JavaIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M10.73 8.41c.57 3 1.59 5.83 2.77 7.09-6.63-3.45-9.76-1.75-10.5 0-.66-3.4-.54-5.74.09-7.78" />
      <path d="M8.5 7c.63.34 1.82 1.07 2.24 1.41-.54-2.9-.64-5.96-.74-7.91-2.13.58-5.73 1.98-6.9 7.22.52-.69 1.72-1.05 2.4-1.22" />
      <path d="M5.5 7A1.5 1.5 0 007 8.5 1.5 1.5 0 008.5 7 1.5 1.5 0 007 5.5 1.5 1.5 0 005.5 7" />
    </LangSvg>
  );
}

export function JavaScriptIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M4.5 11c0 .828427.6715729 1.5 1.5 1.5.8284271 0 1.5-.671573 1.5-1.5V7.5M12.5 8.75C12.5 8.05964406 11.9627417 7.5 11.3 7.5L10.7 7.5C10.0372583 7.5 9.5 8.05964406 9.5 8.75 9.5 9.44035594 10.0372583 10 10.7 10L11.3 10C11.9627417 10 12.5 10.5596441 12.5 11.25 12.5 11.9403559 11.9627417 12.5 11.3 12.5L10.7 12.5C10.0372583 12.5 9.5 11.9403559 9.5 11.25" />
      <path d="m 4,1.5 h 8 c 1.385,0 2.5,1.115 2.5,2.5 v 8 c 0,1.385 -1.115,2.5 -2.5,2.5 H 4 C 2.615,14.5 1.5,13.385 1.5,12 V 4 C 1.5,2.615 2.615,1.5 4,1.5 Z" />
    </LangSvg>
  );
}

export function JsonIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M4.5 2.5H4c-.75 0-1.5.75-1.5 1.5v2c0 1.1-1 2-1.83 2 .83 0 1.83.9 1.83 2v2c0 .75.75 1.5 1.5 1.5h.5m7-11h.5c.75 0 1.5.75 1.5 1.5v2c0 1.1 1 2 1.83 2-.83 0-1.83.9-1.83 2v2c0 .74-.75 1.5-1.5 1.5h-.5m-6.5-3a.5.5 0 100-1 .5.5 0 000 1m3 0a.5.5 0 100-1 .5.5 0 000 1m3 0a.5.5 0 100-1 .5.5 0 000 1" />
    </LangSvg>
  );
}

/** Catppuccin's own "javascript-react" mark — JSX is JavaScript's file kind, not its own name. */
export function JsxIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M8 10.8c4.14 0 7.5-1.25 7.5-2.8S12.14 5.2 8 5.2.5 6.45.5 8s3.36 2.8 7.5 2.8" />
      <path d="M5.52 9.4c2.07 3.5 4.86 5.72 6.23 4.95 1.37-.78.8-4.24-1.27-7.75C8.41 3.1 5.62.88 4.25 1.65c-1.37.78-.8 4.24 1.27 7.75" />
      <path d="M5.52 6.6c-2.07 3.5-2.64 6.97-1.27 7.75 1.37.77 4.16-1.45 6.23-4.95s2.64-6.97 1.27-7.75C10.38.88 7.59 3.1 5.52 6.6" />
      <path d="M8.5 8a.5.5 0 01-.5.5.5.5 0 01-.5-.5.5.5 0 01.5-.5.5.5 0 01.5.5" />
    </LangSvg>
  );
}

/** The source rectangle's rounded corners reach x≈15.5 on a 16-wide canvas — with a 1px stroke
 *  that's flush against the edge, unlike every other icon here. A half-unit larger `viewBox`
 *  gives it the same breathing room the rest already have, without touching its own path data. */
export function MarkdownIcon(props: IconProps) {
  return (
    <LangSvg {...props} viewBox="-0.5 -0.5 17 17">
      <path d="m9.25 8.25 2.25 2.25 2.25-2.25M3.5 11V5.5l2.04 3 1.96-3V11m4-.5V5M1.65 2.5h12.7c.59 0 1.15.49 1.15 1v9c0 .51-.56 1-1.15 1H1.65c-.59 0-1.15-.49-1.15-1V3.58c0-.5.56-1.08 1.15-1.08" />
    </LangSvg>
  );
}

export function PowerShellIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M2 15.5c-.7 0-1.5-.8-1.5-1.5V5c0-.7.8-1.5 1.5-1.5h9c.7 0 1.5.8 1.5 1.5v9c0 .7-.8 1.5-1.5 1.5z" />
      <path d="m1.2 3.8 3.04-2.5S5.17.5 5.7.5h8.4c.66 0 1.4.73 1.4 1.4v7.73a2.7 2.7 0 01-.7 1.75l-2.68 3.51M3 8.5l3 2-3 2m4 0h2" />
    </LangSvg>
  );
}

export function PythonIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M8.5 5.5h-3m6 0V3c0-.8-.7-1.5-1.5-1.5H7c-.8 0-1.5.7-1.5 1.5v2.5H3c-.8 0-1.5.7-1.5 1.5v2c0 .8.7 1.5 1.48 1.5" />
      <path d="M10.5 10.5h-3m-3 0V13c0 .8.7 1.5 1.5 1.5h3c.8 0 1.5-.7 1.5-1.5v-2.5H13c.8 0 1.5-.7 1.5-1.5V7c0-.8-.7-1.5-1.48-1.5H11.5c0 1.5 0 2-1 2h-2" />
      <path d="M2.98 10.5H4.5c0-1.5 0-2 1-2h2M7.5 3.5v0" />
      <path d="m 8.5,12.5 v 0" />
    </LangSvg>
  );
}

export function RustIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M15.5 9.5Q8 13.505.5 9.5l1-1-1-2 2-.5V4.5h2l.5-2 1.5 1 1.5-2 1.5 2 1.5-1 .5 2h2V6l2 .5-1 2z" />
      <path d="M6.5 7.5a1 1 0 01-1 1 1 1 0 01-1-1 1 1 0 011-1 1 1 0 011 1m5 0a1 1 0 01-1 1 1 1 0 01-1-1 1 1 0 011-1 1 1 0 011 1M4 11.02c-.67.37-1.5.98-1.5 2.23s1.22 1.22 2 1.25v-2M12 11c.67.37 1.5 1 1.5 2.25s-1.22 1.22-2 1.25v-2" />
    </LangSvg>
  );
}

/** Catppuccin's "bash" mark — every shell dialect diff-highlight.ts lumps under one grammar. */
export function ShellScriptIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M2 15.5c-.7 0-1.5-.8-1.5-1.5V5c0-.7.8-1.5 1.5-1.5h9c.7 0 1.5.8 1.5 1.5v9c0 .7-.8 1.5-1.5 1.5z" />
      <path d="m1.2 3.8 3.04-2.5S5.17.5 5.7.5h8.4c.66 0 1.4.73 1.4 1.4v7.73a2.7 2.7 0 01-.7 1.75l-2.68 3.51" />
      <path d="M6 8.75c0-.69-.54-1.25-1.2-1.25h-.6c-.66 0-1.2.56-1.2 1.25S3.54 10 4.2 10h.6c.66 0 1.2.56 1.2 1.25s-.54 1.25-1.2 1.25h-.6c-.66 0-1.2-.56-1.2-1.25M4.5 6.5v1m0 5v1" />
    </LangSvg>
  );
}

/** Catppuccin's "database" mark, stood in for SQL — the file kind rather than one engine's dialect. */
export function SqlIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M8 6.5c3.59 0 6.5-1.4 6.5-2.68S11.59 1.5 8 1.5 1.5 2.54 1.5 3.82 4.41 6.5 8 6.5M14.5 8c0 .83-1.24 1.79-3.25 2.2s-4.49.41-6.5 0S1.5 8.83 1.5 8m13 4.18c0 .83-1.24 1.6-3.25 2-2.01.42-4.49.42-6.5 0-2.01-.4-3.25-1.17-3.25-2m0-8.3v8.3m13-8.3v8.3" />
    </LangSvg>
  );
}

export function TomlIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M3.5 1.5h-2v13h2m9-13h2v13h-2m-8-11h7v3h-2v6h-3v-6h-2z" />
    </LangSvg>
  );
}

/** Catppuccin's own "typescript-react" mark — TSX is TypeScript's file kind, not its own name. */
export function TsxIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M8 11.3c4.14 0 7.5-1.28 7.5-2.86S12.14 5.58 8 5.58.5 6.86.5 8.44s3.36 2.87 7.5 2.87Z" />
      <path d="M5.52 9.87c2.07 3.6 4.86 5.86 6.23 5.07 1.37-.8.8-4.34-1.27-7.93S5.62 1.16 4.25 1.95s-.8 4.34 1.27 7.92" />
      <path d="M5.52 7.01c-2.07 3.59-2.64 7.14-1.27 7.93s4.16-1.48 6.23-5.07c2.07-3.58 2.64-7.13 1.27-7.92-1.37-.8-4.16 1.47-6.23 5.06" />
      <path d="M8.5 8.44a.5.5 0 01-.5.5.5.5 0 01-.5-.5.5.5 0 01.5-.5.5.5 0 01.5.5" />
    </LangSvg>
  );
}

export function TypeScriptIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M4 1.5h8A2.5 2.5 0 0114.5 4v8a2.5 2.5 0 01-2.5 2.5H4A2.5 2.5 0 011.5 12V4A2.5 2.5 0 014 1.5" />
      <path d="M12.5 8.75c0-.69-.54-1.25-1.2-1.25h-.6c-.66 0-1.2.56-1.2 1.25S10.04 10 10.7 10h.6c.66 0 1.2.56 1.2 1.25s-.54 1.25-1.2 1.25h-.6c-.66 0-1.2-.56-1.2-1.25m-3-3.75v5M5 7.5h3" />
    </LangSvg>
  );
}

export function XmlIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M4.5 4.5 1 8 4.5 11.5M11.5 4.5 15 8 11.5 11.5M9.5 2 6.5 14" />
    </LangSvg>
  );
}

export function YamlIcon(props: IconProps) {
  return (
    <LangSvg {...props}>
      <path d="M2.5 1.5h3l3 4 3-4h3l-9 13h-3L7 8z" />
    </LangSvg>
  );
}
