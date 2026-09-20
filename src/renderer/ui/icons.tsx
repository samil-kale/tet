import type { NoticeSeverity } from "../../shared/types";

export interface IconProps {
  className?: string;
}

/** The share of its 16-unit box every icon's drawing is cut to cover. */
const TARGET_EXTENT = 12.8;
const GRID = 16;

/**
 * Fits an icon by how much of its grid it actually draws on.
 *
 * Measured with `getBBox`, the icons cover 59% (the chevron) to 100% (Claude's mark) of their
 * grid, so equal `width`s look unequal. Each declares its measured extent, and the viewBox is
 * cropped to put that extent at TARGET_EXTENT. `strokeWidth` scales by the same factor, or the
 * crop would thicken every enlarged stroke.
 *
 * Extents are tuned to the **geometric mean**, not the longer side: 12 by 9 carries far less ink
 * than 12 by 12. Each is capped at about 87% of the box in the long axis, so a chevron or a row of
 * dots does not outgrow its place.
 *
 * Re-measure when a path changes: render every icon and read `getBBox()` on each child, grown by
 * half a stroke.
 *
 * The box is `--icon-size` (13px), stated in CSS. A new icon comes from Lucide first (lucide.dev,
 * ISC), vendored on its 24-unit grid (`fitIcon`/`fitStroke`); a hand drawing is for what Lucide
 * has no match for.
 */
function geometry(extent: number, cx: number, cy: number, grid: number, stroke: number) {
  const side = (extent * grid) / ((TARGET_EXTENT / GRID) * grid);
  return {
    viewBox: `${cx - side / 2} ${cy - side / 2} ${side} ${side}`,
    strokeWidth: (stroke * side) / grid
  };
}

/** The same fitting for an icon on its own grid (Lucide's 24, agent-icons.tsx). */
export function fitIcon(extent: number, cx: number, cy: number, grid: number, stroke = 0): string {
  return geometry(extent, cx, cy, grid, stroke).viewBox;
}

export function fitStroke(extent: number, grid: number, stroke: number): number {
  return geometry(extent, 0, 0, grid, stroke).strokeWidth;
}

/**
 * Draws an icon two pixels under the shared `--icon-size`, as a ratio so it holds for any size.
 * The box stays; only the drawing shrinks.
 */
export const SMALLER = 11 / 13;

/** Two pixels over, for an icon that should read larger. */
export const LARGER = 15 / 13;

/** A tree's folding chevron, in the git pane and the Explorer alike: 10px drawn at the 13px
 *  `--icon-size`, which draws TARGET_EXTENT/GRID of it (10.4px) unscaled. */
export const TREE_CHEVRON = 10 / 10.4;

/**
 * `extent` (stroke included) and the centre `cx`/`cy` on the 16 grid are measured. `scale` is a
 * *choice* — read smaller than the neighbours — kept apart so the extent stays re-measurable.
 */
function Svg({
  children,
  className,
  extent = TARGET_EXTENT,
  cx = 8,
  cy = 8,
  scale = 1,
  grid = GRID,
  stroke = 1.5
}: IconProps & {
  children: React.ReactNode;
  extent?: number;
  cx?: number;
  cy?: number;
  scale?: number;
  /** The units the drawing was authored on — tet's own 16, Lucide's 24 (see `Lucide`). */
  grid?: number;
  /** The drawing's own stroke on that grid, scaled by the crop like everything else. */
  stroke?: number;
}) {
  // Dividing widens the crop, shrinking the drawing in the same box.
  const { viewBox, strokeWidth } = geometry(extent / scale, cx, cy, grid, stroke);
  return (
    <svg
      className={className}
      // Fallback only: CSS `--icon-size` renders over these in a flex container; keep them equal.
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

/**
 * A vendored Lucide icon (lucide.dev, ISC): its native 24-unit grid, centred where most of them
 * are, and its stroke of 2. Only the measured `extent` differs from one to the next — an icon off
 * that centre or drawn heavier says so, and one drawn `SMALLER`/`LARGER` passes it as `scale`.
 */
function Lucide(props: Parameters<typeof Svg>[0]) {
  return <Svg grid={24} cx={12} cy={12} stroke={2} {...props} />;
}

/** Lucide's `plus`. Measured: 16 by 16, extent 16, centered at (12, 12). Stroke 2.3 instead of
 *  Lucide's 2, to read heavier leading a row. */
export function PlusIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={16} stroke={2.3}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Lucide>
  );
}

/** Lucide's `x`, vendored the same way, drawn `SMALLER` (measured extent divided by it): 14 by 14,
 *  extent 14 becomes 16.55, centered at (12, 12). */
export function CloseIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={14} scale={SMALLER}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Lucide>
  );
}

/** Lucide's `shield`, vendored the same way — a project sandboxed by sbx. Tall, so the long-side
 *  cap: measured 18 by 22 (stroke included), extent 20.23, centered at (12, 12). Full size: it
 *  stands beside the session marks in the project row. */
export function ShieldIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.23}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </Lucide>
  );
}

/** Lucide's `file-diff`, vendored the same way — the project row's mark for uncommitted changes.
 *  Tall, so the long-side cap: measured 18 by 22 (stroke included), extent 20.23, centered at
 *  (12, 12). */
export function ChangesIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.23}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M9 10h6" />
      <path d="M12 13V7" />
      <path d="M9 17h6" />
    </Lucide>
  );
}

/**
 * Notice severities in a shared circle — cross, exclamation, "i" — so the shape carries the
 * meaning as well as the color.
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

/** Lucide's `git-branch`, on its native 24-unit grid. Measured: 20 by 20, extent 20, centered at
 *  (12, 12). */
export function BranchIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20}>
      <path d="M15 6a9 9 0 0 0-9 9V3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </Lucide>
  );
}

/** Lucide's `folder-git-2`, on its native 24-unit grid — a worktree. From its path bounds, stroke
 *  included: 22 by 21, extent 21.49 (the geometric mean), centered at (12, 12.5). */
export function WorktreeIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={21.49} cy={12.5}>
      <path d="M18 19a5 5 0 0 1-5-5v8" />
      <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
      <circle cx="13" cy="12" r="2" />
      <circle cx="20" cy="19" r="2" />
    </Lucide>
  );
}

/**
 * Git's mark as a hollow outline (`git-alt`): one filled path on a 32-unit grid. Measured: tips
 * at 2 and 30, a bbox of side 28 centred at (16, 16). A step past `LARGER`, since a diamond inks
 * half its bbox; three pixels over is the limit, beyond which the tips clip.
 */
const GIT_SCALE = 16 / 13;

export function GitIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(28 / GIT_SCALE, 16, 16, 32)}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M16 2c-.504 0-.996.184-1.375.563l-2.813 2.843c-.152.082-.28.2-.374.344l-8.876 8.875a1.947 1.947 0 0 0 0 2.75l12.063 12.063a1.955 1.955 0 0 0 2.75 0l12.063-12.063a1.947 1.947 0 0 0 0-2.75L17.374 2.562A1.92 1.92 0 0 0 16 2m0 2.031L27.969 16L16 27.969L4.031 16l8.282-8.281l1.75 1.75A2 2 0 0 0 14 10c0 .738.402 1.371 1 1.719v8.562c-.598.348-1 .98-1 1.719a1.999 1.999 0 1 0 4 0c0-.738-.402-1.371-1-1.719v-7.843l3.063 3.062A2 2 0 0 0 22 18a2 2 0 0 0 1.999-2a2 2 0 0 0-2.5-1.938L17.937 10.5A2 2 0 0 0 16 8a2 2 0 0 0-.53.063l-1.75-1.75z"
      />
    </svg>
  );
}

/** Lucide's `search`, on its native 24-unit grid. Measured: 20 by 20, extent 20, centered at
 *  (12, 12). */
export function SearchIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20}>
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </Lucide>
  );
}

/** Lucide's `case-sensitive` — the search field's "Match Case", VS Code's `Aa`. Wide and flat, so
 *  the long-side cap, which their geometric mean (14.14) would have drawn past the box: measured
 *  20 by 10 (stroke included), extent 18.39, centered at (12, 11). */
export function CaseSensitiveIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={18.39} cy={11}>
      <path d="m3 15 4-8 4 8" />
      <path d="M4 13h6" />
      <circle cx="18" cy="12" r="3" />
      <path d="M21 9v6" />
    </Lucide>
  );
}

/** Lucide's `whole-word` — "Match Whole Word", VS Code's underlined `ab`. The long-side cap again,
 *  so it reads level with the `Aa` beside it: measured 22 by 14 (stroke included), extent 20.23,
 *  centered at (12, 13). */
export function WholeWordIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.23} cy={13}>
      <circle cx="7" cy="12" r="3" />
      <path d="M10 9v6" />
      <circle cx="17" cy="12" r="3" />
      <path d="M14 7v8" />
      <path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1" />
    </Lucide>
  );
}

/** Lucide's `regex` — "Use Regular Expression", VS Code's `.*`. Measured: 20.33 by 20, extent
 *  20.16, centered at (12.17, 12). */
export function RegexIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.16} cx={12.17}>
      <path d="M17 3v10" />
      <path d="m12.67 5.5 8.66 5" />
      <path d="m12.67 10.5 8.66-5" />
      <path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2z" />
    </Lucide>
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
 * A gapped ring, used with the `spinning` class in place of the running action's icon. The dash
 * pattern splits the circumference 2π·5 ≈ 31 into arc 23 and gap 8; re-cut it if the radius moves.
 */
export function SpinnerIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.34}>
      <circle cx="8" cy="8" r="5" strokeDasharray="23 8" />
    </Svg>
  );
}

/** Lucide's `wand` (lucide.dev, ISC), on its native 24-unit grid — a model's suggestion.
 *  Measured: 21 by 21, extent 21, centered at (12.5, 11.5). */
export function SparkleIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={21} cx={12.5} cy={11.5}>
      <path d="M15 4V2" />
      <path d="M15 16v-2" />
      <path d="M8 9h2" />
      <path d="M20 9h2" />
      <path d="M17.8 11.8 19 13" />
      <path d="M15 9h.01" />
      <path d="M17.8 6.2 19 5" />
      <path d="m3 21 9-9" />
      <path d="M12.2 6.2 11 5" />
    </Lucide>
  );
}

/** Lucide's `play`, on its native 24-unit grid, `SMALLER` like `CloseIcon`: measured 18 by 20
 *  (stroke included), extent 18.98 becomes 22.43, centered at (13, 12). */
export function PlayIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={18.98} scale={SMALLER} cx={13}>
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    </Lucide>
  );
}

/** Lucide's `tag`, on its native 24-unit grid. Measured: 22 by 22, extent 22, centered at
 *  (12, 12). */
export function TagIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={22}>
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </Lucide>
  );
}

/** Lucide's `git-commit-horizontal`, vendored the same way. Wide and flat, so the long-side cap:
 *  measured 20 by 8, extent 18.39, centered at (12, 12). */
export function CommitIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={18.39}>
      <circle cx="12" cy="12" r="3" />
      <line x1="3" x2="9" y1="12" y2="12" />
      <line x1="15" x2="21" y1="12" y2="12" />
    </Lucide>
  );
}

/** A stash, drawn as an inbox tray. */
export function StashIcon(props: IconProps) {
  return (
    <Svg {...props} extent={12.54} cy={8.5}>
      <path d="M2 9.5l1.8-5A1 1 0 0 1 4.8 4h6.4a1 1 0 0 1 1 .5L14 9.5" />
      <path d="M2 9.5h3.2l.8 1.6h4l.8-1.6H14v2A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Svg>
  );
}

/** Lucide's `trash`, on its native 24-unit grid — discard, beside the stash's "put away".
 *  Measured: 20 by 22; the geometric mean would clip the bottom, so the long-axis cap: extent
 *  20.98, centered at (12, 12). */
export function DiscardIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.98}>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Lucide>
  );
}

/** Lucide's `arrow-up`, on its native 24-unit grid. Measured: 16 by 16, extent 16, centered at
 *  (12, 12). */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={16}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </Lucide>
  );
}

/** Lucide's `arrow-down`, vendored the same way. Measured: 16 by 16, extent 16, centered at
 *  (12, 12). */
export function ArrowDownIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={16}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Lucide>
  );
}

/** Lucide's `refresh-cw`, on its native 24-unit grid — fetch. Measured: 20 by 20, extent 20,
 *  centered at (12, 12). */
export function SyncIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </Lucide>
  );
}

/**
 * A session stopped on an unanswered question, on its tab and project row. Shares the mark slot
 * with the bubble and the spinner, so it must differ from them at a glance.
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
 * Lucide's `circle-alert`, on its native 24-unit grid — what cannot work as it stands: a tab whose
 * agent cannot start, a sbx-settings row or tab. Measured: 22 by 22, extent 22, centered at (12, 12).
 * Its own color, not `--vscode-focusBorder`: see `.session-mark-error`.
 */
export function CircleAlertIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={22}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </Lucide>
  );
}

/** Lucide's `message-square`, on its native 24-unit grid — a finished turn nobody has seen yet.
 *  Measured: 22 by 21, extent 21.49, centered at (12, 12.5). */
export function CommentIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={21.49} cy={12.5}>
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
    </Lucide>
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

/** Lucide's `settings`, on its native 24-unit grid. Measured: 20 by 22, extent 20.91, centered at
 *  (12, 12). Drawn `LARGER`: a gear is mostly gaps and reads small beside the git mark. */
export function GearIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.91} scale={LARGER}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </Lucide>
  );
}

/** Lucide's `file-braces` (lucide.dev, ISC), on its native 24-unit grid — the files view.
 *  Measured: 18 by 22; the geometric mean would clip the bottom, so the long-axis cap: extent
 *  20.23, centered at (12, 12). */
export function FilesIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.23}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
      <path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
    </Lucide>
  );
}

/** The EXPLORER header's "New File...": Lucide's `file-plus` (lucide.dev, ISC), on its native
 *  24-unit grid (`fitIcon`/`fitStroke` take the grid). Measured, stroke included: 18 by 22; the
 *  geometric mean would clip the bottom, so the long-axis cap: extent 20.23, centered at (12, 12). */
export function NewFileIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.23}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M9 15h6" />
      <path d="M12 18v-6" />
    </Lucide>
  );
}

/** The EXPLORER header's "New Folder...": Lucide's `folder-plus`, vendored the same way.
 *  Measured: 22 by 19, square enough for the uncapped geometric mean: extent 20.45, centered at
 *  (12, 11.5). */
export function NewFolderIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.45} cy={11.5}>
      <path d="M12 10v6" />
      <path d="M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Lucide>
  );
}

/** "Collapse Folders in Explorer": Lucide's `copy-minus`. Measured: 22 by 22, extent 22, centered
 *  at (12, 12). */
export function CollapseAllIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={22}>
      <line x1="12" x2="18" y1="15" y2="15" />
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Lucide>
  );
}

/** The results pane's "Expand All": Lucide's `copy-plus`, `copy-minus` with one line more, which
 *  sits inside its box — the same extent. */
export function ExpandAllIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={22}>
      <line x1="15" x2="15" y1="12" y2="18" />
      <line x1="12" x2="18" y1="15" y2="15" />
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Lucide>
  );
}

/** Both files-pane headers' "Clear": Lucide's `list-x`. Wide, so the long-side cap: measured 19.5
 *  by 16 (stroke included), extent 17.93, centered at (11.75, 12). */
export function ClearIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={17.93} cx={11.75}>
      <path d="M16 5H3" />
      <path d="M11 12H3" />
      <path d="M16 19H3" />
      <path d="m15.5 9.5 5 5" />
      <path d="m20.5 9.5-5 5" />
    </Lucide>
  );
}

/** Lucide's `save`, vendored the same way. Measured: 20 by 20, extent 20, centered at (12, 12). */
export function SaveIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20}>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </Lucide>
  );
}

/** Lucide's `eye`, vendored the same way — a Markdown preview. Wide, so the long-side cap:
 *  measured 22 by 16 (stroke included), extent 20.23, centered at (12, 12). */
export function EyeIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20.23}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </Lucide>
  );
}

/** Lucide's `git-compare`, vendored the same way — the editor tab's diff toggle. Square: measured
 *  20 by 20 (stroke included), extent 20, centered at (12, 12). */
export function CompareIcon(props: IconProps) {
  return (
    <Lucide {...props} extent={20}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M11 18H8a2 2 0 0 1-2-2V9" />
    </Lucide>
  );
}
