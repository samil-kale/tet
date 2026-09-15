import type { NoticeSeverity } from "../../shared/types";

export interface IconProps {
  className?: string;
}

/** The share of its box a finished icon's drawing covers. Every icon is cut to this. */
const TARGET_EXTENT = 12.8;
const GRID = 16;

/**
 * How an icon is fitted, given how much of its own grid it actually draws on.
 *
 * A box is not a size: measured with `getBBox`, the icons here cover anywhere from 59% of their
 * grid (the chevron) to 100% (Claude's mark), so identical `width`s produce visibly different
 * icons. Each declares the extent it was measured at, and the viewBox is cropped to put that
 * extent at TARGET_EXTENT of the box. `strokeWidth` is scaled by the same factor, or a cropped
 * viewBox would thicken the stroke of every icon it enlarges.
 *
 * The extents are tuned to the icon's **geometric mean**, not its longer side: a shape 12 wide
 * and 9 tall carries far less ink than one 12 by 12. Each is capped at about 87% of its box in
 * the long axis, so a chevron or a row of dots does not grow out of its place trying to average
 * out.
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
 * `--icon-size`, as a ratio so it holds whatever that size is set to. The box does not change,
 * only the drawing inside it.
 */
export const SMALLER = 11 / 13;

/** The same two pixels the other way, for an icon that asks to read larger — see agent-icons.tsx. */
export const LARGER = 15 / 13;

/**
 * `extent` is how much of the 16 grid this icon draws on, stroke included, and `cx`/`cy` where
 * that drawing is centred. All three are measured.
 *
 * `scale` is the one number here that is a *choice* rather than an observation: it says this
 * icon should read smaller than its neighbours. Kept separate so a measured extent stays
 * re-measurable.
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
      // The shared icon size, the same one `--icon-size` states in CSS. CSS decides — a flex
      // container renders over these attributes — so this is only the fallback, and must not
      // disagree with it.
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

/** Lucide's `plus` (lucide.dev, ISC), vendored on its own native 24-unit grid. Measured via
 *  `getBBox`: 16 by 16, extent 16, centered at (12, 12). Stroke bumped past Lucide's own 2 to
 *  2.3, so it reads a touch heavier where it leads a row. */
export function PlusIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(16, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(16, 24, 2.3)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

/** Lucide's `x`, vendored the same way. `SMALLER` widens the crop as it does for `Svg`'s own
 *  `scale`, so the extent fed to `fitIcon`/`fitStroke` is the measured one divided by it: 14 by
 *  14 (extent 14) becomes 16.55, centered at (12, 12). */
export function CloseIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(14 / SMALLER, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(14 / SMALLER, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/** Lucide's `pin`, vendored the same way, and `SMALLER` like the x beside it. Tall and narrow,
 *  so the extent is the long-side cap rather than the geometric mean: measured 16 by 22 (stroke
 *  included) gives extent 20.23, becoming 23.91, centered at (12, 12). The pinned state is CSS's
 *  to draw: `fill: currentColor` on a `pinned` class beats the `fill="none"` attribute below. */
export function PinIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20.23 / SMALLER, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20.23 / SMALLER, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

/** Lucide's `shield`, vendored the same way — a project whose agents run in an sbx sandbox.
 *  Tall and narrow like the pin above, so the long-side cap rather than the geometric mean:
 *  measured 18 by 22 (stroke included) gives extent 20.23, centered at (12, 12). Full size, not
 *  `SMALLER`: it stands in the project row beside the session marks. */
export function ShieldIcon(props: IconProps) {
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
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

/** Lucide's `file-diff`, vendored the same way — a repository with uncommitted changes, which is
 *  what the project row's mark stands for and what pressing it opens. Tall and narrow like the
 *  shield above, so the same long-side cap: measured 18 by 22 (stroke included) gives extent
 *  20.23, centered at (12, 12). */
export function ChangesIcon(props: IconProps) {
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
      <path d="M9 10h6" />
      <path d="M12 13V7" />
      <path d="M9 17h6" />
    </svg>
  );
}

/**
 * The three notification shapes: a cross for an error, an exclamation for a warning, an "i" for
 * information, each in the circle they share, so the outline carries the meaning the color does.
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

/** Lucide's `git-branch`, vendored on its own native 24-unit grid. Measured via `getBBox`: 20 by
 *  20, extent 20, centered at (12, 12). */
export function BranchIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 6a9 9 0 0 0-9 9V3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </svg>
  );
}

/**
 * Git's mark as a hollow outline (`git-alt`): a rotated square with rounded corners, drawn as one
 * filled path with the commits and the branch cut out of it, on a 32-unit grid. Measured: the
 * square's rounded tips sit at 2 and 30, so the bbox is a square of side 28 centred at (16, 16).
 * Drawn a step past `LARGER`, since a diamond inks only half of its own bbox and reads small
 * beside the square icons around it. Three pixels over the shared size is the limit — the drawing
 * then fills the box, and anything past that clips its tips.
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

/** Lucide's `search`, vendored on its own native 24-unit grid. Measured via `getBBox`: 20 by 20,
 *  extent 20, centered at (12, 12). */
export function SearchIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </svg>
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
 * `spinning` class. Takes the place of the icon whose action is running. The dash pattern is the
 * circumference: 2π·5 ≈ 31, an arc of 23 and a gap of 8. Re-cut it whenever the radius moves.
 */
export function SpinnerIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.34}>
      <circle cx="8" cy="8" r="5" strokeDasharray="23 8" />
    </Svg>
  );
}

/** Lucide's `wand` (lucide.dev, ISC), vendored on its own native 24-unit grid — "a model worked
 *  this out for you". Measured via `getBBox`: 21 by 21, extent 21, centered at (12.5, 11.5). */
export function SparkleIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(21, 12.5, 11.5, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(21, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 4V2" />
      <path d="M15 16v-2" />
      <path d="M8 9h2" />
      <path d="M20 9h2" />
      <path d="M17.8 11.8 19 13" />
      <path d="M15 9h.01" />
      <path d="M17.8 6.2 19 5" />
      <path d="m3 21 9-9" />
      <path d="M12.2 6.2 11 5" />
    </svg>
  );
}

/** Lucide's `play`, vendored on its own native 24-unit grid. `SMALLER` like `CloseIcon`: measured
 *  18 by 20 (extent 18.98, stroke included) becomes 22.43, centered at (13, 12). */
export function PlayIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(18.98 / SMALLER, 13, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(18.98 / SMALLER, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    </svg>
  );
}

/** Lucide's `tag`, vendored on its own native 24-unit grid. Measured via `getBBox`: 22 by 22,
 *  extent 22, centered at (12, 12). */
export function TagIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(22, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(22, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

/** Lucide's `git-commit-horizontal`, vendored the same way. Wide and flat, so the extent is the
 *  long-side cap rather than the geometric mean: measured 20 by 8 gives 18.39, centered at
 *  (12, 12). */
export function CommitIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(18.39, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(18.39, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <line x1="3" x2="9" y1="12" y2="12" />
      <line x1="15" x2="21" y1="12" y2="12" />
    </svg>
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

/** Lucide's `trash`, vendored on its own native 24-unit grid — throwing local changes away, and
 *  next to the stash box the pair reads as "put away" and "throw away". Measured via `getBBox`:
 *  20 by 22; the geometric mean would clip the bottom, so extent is the long-axis cap: 20.98,
 *  centered at (12, 12). */
export function DiscardIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20.98, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20.98, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/** Lucide's `arrow-up`, vendored on its own native 24-unit grid. Measured via `getBBox`: 16 by
 *  16, extent 16, centered at (12, 12). */
export function ArrowUpIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(16, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(16, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  );
}

/** Lucide's `arrow-down`, vendored the same way. Measured via `getBBox`: 16 by 16, extent 16,
 *  centered at (12, 12). */
export function ArrowDownIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(16, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(16, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

/** Lucide's `refresh-cw`, vendored on its own native 24-unit grid — fetch. Measured via
 *  `getBBox`: 20 by 20, extent 20, centered at (12, 12). */
export function SyncIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

/**
 * A session stopped mid-turn on a question nobody has answered — on its tab and on its project's
 * row. It shares the one mark slot with the bubble and the spinner, so the three have to be told
 * apart at a glance.
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
 * A tab whose agent cannot start at all. Same mark slot as the question mark and the spinner, so
 * the same family of shape, not a circle-and-cross like a `SeverityIcon`. Its own color, not
 * `--vscode-focusBorder`: see `.session-mark-error`.
 */
export function ExclamationIcon(props: IconProps) {
  return (
    <Svg {...props} extent={9.95} cy={7.86}>
      <path d="M8 3.2v6.3" />
      <circle cx="8" cy="12.1" r="0.42" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Lucide's `message-square`, vendored on its own native 24-unit grid — a session answered and
 *  nobody has looked yet. Measured via `getBBox`: 22 by 21, extent 21.49, centered at
 *  (12, 12.5). */
export function CommentIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(21.49, 12, 12.5, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(21.49, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
    </svg>
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

/** Lucide's `settings`, vendored on its own native 24-unit grid. Measured via `getBBox`: 20 by
 *  22, extent 20.91, centered at (12, 12). Drawn `LARGER`: a gear is mostly teeth and gaps, and
 *  at the shared extent it read small beside the git mark next to it. */
export function GearIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20.91 / LARGER, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20.91 / LARGER, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Lucide's `file-braces` (lucide.dev, ISC), vendored on its own native 24-unit grid — browsing
 *  the repository's files. Measured via `getBBox`: 18 by 22; the geometric mean would clip the
 *  bottom, so extent is the long-axis cap: 20.23, centered at (12, 12). */
export function FilesIcon(props: IconProps) {
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
      <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
      <path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
    </svg>
  );
}

/** The EXPLORER header's own "New File...": Lucide's `file-plus` (lucide.dev, ISC), vendored on
 *  its own native 24-unit grid rather than rescaled into this file's 16-unit one — `fitIcon`/
 *  `fitStroke` take the grid as a parameter for exactly this. Measured via `getBBox`, stroke
 *  included: 18 by 22, whose geometric mean would clip the bottom, so extent is the long-axis
 *  cap: 20.23, centered at (12, 12). */
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
 *  vendored the same way. Measured via `getBBox`: 22 by 19, square enough that the geometric
 *  mean needs no cap: extent 20.45, centered at (12, 11.5). */
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

/** "Collapse Folders in Explorer": Lucide's `copy-minus`, a shrinking stack. Measured via
 *  `getBBox`: 22 by 22, extent 22, centered at (12, 12). */
export function CollapseAllIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(22, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(22, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" x2="18" y1="15" y2="15" />
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

/** Lucide's `save`, vendored the same way. Measured via `getBBox`: 20 by 20, extent 20, centered
 *  at (12, 12). */
export function SaveIcon(props: IconProps) {
  return (
    <svg
      className={props.className}
      width="13"
      height="13"
      viewBox={fitIcon(20, 12, 12, 24)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(20, 24, 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </svg>
  );
}
