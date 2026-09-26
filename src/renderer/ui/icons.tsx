import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  Check,
  CircleAlert,
  CopyMinus,
  CopyPlus,
  Eye,
  FileBraces,
  FileDiff,
  FilePlus,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  Landmark,
  ListX,
  LogIn,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Regex,
  Save,
  Search,
  Settings,
  Shield,
  Tag,
  Trash,
  Wand,
  WholeWord,
  X,
  type LucideIcon
} from "lucide-react";
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
 * The box is `--icon-size` (13px), stated in CSS. A new icon comes from lucide-react first
 * (`Lucide`); a hand drawing (`Svg`, or `FillSvg` for a fill-only one) is for what Lucide has no
 * match for.
 */
function geometry(extent: number, cx: number, cy: number, grid: number, stroke: number) {
  const side = (extent * grid) / ((TARGET_EXTENT / GRID) * grid);
  return {
    viewBox: `${cx - side / 2} ${cy - side / 2} ${side} ${side}`,
    strokeWidth: (stroke * side) / grid
  };
}

/** `Svg`'s box for a fill-only icon on its own grid (git's mark, agent-icons.tsx): the same
 *  fitting, nothing stroked. `extent` is measured, a `scale` already divided in. */
export function FillSvg({
  className,
  extent,
  cx,
  cy,
  grid,
  shapeRendering,
  children
}: IconProps & {
  extent: number;
  cx: number;
  cy: number;
  grid: number;
  shapeRendering?: "crispEdges";
  children: React.ReactNode;
}) {
  return (
    <svg
      className={className}
      // Fallback only, as `Svg`'s.
      width="13"
      height="13"
      viewBox={geometry(extent, cx, cy, grid, 0).viewBox}
      shapeRendering={shapeRendering}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * Draws an icon two pixels under the shared `--icon-size`, as a ratio so it holds for any size.
 * The box stays; only the drawing shrinks.
 */
const SMALLER = 11 / 13;

/** Two pixels over, for an icon that should read larger. */
export const LARGER = 15 / 13;

/** A tree's folding chevron, in the git pane and the Explorer alike: 10px drawn at the 13px
 *  `--icon-size`, which draws TARGET_EXTENT/GRID of it (10.4px) unscaled. */
export const TREE_CHEVRON = 10 / 10.4;

/**
 * `extent` (stroke included) and the centre `cx`/`cy` on the 16 grid are measured. `scale` is a
 * *choice* — read smaller than the neighbours — kept apart so the extent stays re-measurable.
 * Also the stroked agent icons' box (agent-icons.tsx).
 */
export function Svg({
  children,
  className,
  extent = TARGET_EXTENT,
  cx = 8,
  cy = 8,
  scale = 1,
  stroke = 1.5
}: IconProps & {
  children: React.ReactNode;
  extent?: number;
  cx?: number;
  cy?: number;
  scale?: number;
  /** The drawing's own stroke on the 16 grid, scaled by the crop like everything else. */
  stroke?: number;
}) {
  // Dividing widens the crop, shrinking the drawing in the same box.
  const { viewBox, strokeWidth } = geometry(extent / scale, cx, cy, GRID, stroke);
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
 * A lucide-react icon, cropped like `Svg`: its native 24-unit grid, centred where most of them are,
 * and its stroke of 2. Only the measured `extent` differs from one to the next — an icon off that
 * centre or drawn heavier says so, and one drawn `SMALLER`/`LARGER` passes it as `scale`. The
 * extents hold for the paths lucide-react ships; re-measure when an update redraws one.
 */
function Lucide({
  icon: Icon,
  className,
  extent,
  cx = 12,
  cy = 12,
  scale = 1,
  stroke = 2
}: IconProps & {
  icon: LucideIcon;
  extent: number;
  cx?: number;
  cy?: number;
  scale?: number;
  stroke?: number;
}) {
  const { viewBox, strokeWidth } = geometry(extent / scale, cx, cy, 24, stroke);
  // `size` is the fallback only, as `Svg`'s width and height; `viewBox` overrides lucide's own.
  return <Icon className={className} size={13} viewBox={viewBox} strokeWidth={strokeWidth} />;
}

/** Lucide's `plus`. Measured: 16 by 16, extent 16, centered at (12, 12). Stroke 2.3 instead of
 *  Lucide's 2, to read heavier leading a row. */
export function PlusIcon(props: IconProps) {
  return <Lucide {...props} icon={Plus} extent={16} stroke={2.3} />;
}

/** Lucide's `x`, drawn `SMALLER` (measured extent divided by it): 14 by 14, extent 14 becomes
 *  16.55, centered at (12, 12). */
export function CloseIcon(props: IconProps) {
  return <Lucide {...props} icon={X} extent={14} scale={SMALLER} />;
}

/** Lucide's `log-in` — sign in with an SBX access token. Measured: 20 by 20, extent 20, centered at
 *  (12, 12). */
export function LogInIcon(props: IconProps) {
  return <Lucide {...props} icon={LogIn} extent={20} />;
}

/** Lucide's `check` — the SBX access token signed in with. Measured: 18 by 13, extent 15.3,
 *  centered at (12, 11.5). */
export function CheckIcon(props: IconProps) {
  return <Lucide {...props} icon={Check} extent={15.3} cy={11.5} />;
}

/** Lucide's `shield` — a project sandboxed by sbx. Tall, so the long-side cap: measured 18 by 22
 *  (stroke included), extent 20.23, centered at (12, 12). Full size: it stands beside the session
 *  marks in the project row. */
export function ShieldIcon(props: IconProps) {
  return <Lucide {...props} icon={Shield} extent={20.23} />;
}

/** Lucide's `landmark` — sbx's policy governed by an organization. Tall, so the long-side cap:
 *  measured 20 by 22 (stroke included), extent 20.23, centered at (12, 12). */
export function LandmarkIcon(props: IconProps) {
  return <Lucide {...props} icon={Landmark} extent={20.23} />;
}

/** Lucide's `file-diff` — the project row's mark for uncommitted changes. Tall, so the long-side
 *  cap: measured 18 by 22 (stroke included), extent 20.23, centered at (12, 12). */
export function ChangesIcon(props: IconProps) {
  return <Lucide {...props} icon={FileDiff} extent={20.23} />;
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

/** Lucide's `git-branch`. Measured: 20 by 20, extent 20, centered at (12, 12). */
export function BranchIcon(props: IconProps) {
  return <Lucide {...props} icon={GitBranch} extent={20} />;
}

/** Lucide's `folder-git-2` — a worktree. From its path bounds, stroke included: 22 by 21, extent
 *  21.49 (the geometric mean), centered at (12, 12.5). */
export function WorktreeIcon(props: IconProps) {
  return <Lucide {...props} icon={FolderGit2} extent={21.49} cy={12.5} />;
}

/**
 * Git's mark as a hollow outline (`git-alt`): one filled path on a 32-unit grid. Measured: tips
 * at 2 and 30, a bbox of side 28 centred at (16, 16). A step past `LARGER`, since a diamond inks
 * half its bbox; three pixels over is the limit, beyond which the tips clip.
 */
const GIT_SCALE = 16 / 13;

export function GitIcon(props: IconProps) {
  return (
    <FillSvg className={props.className} extent={28 / GIT_SCALE} cx={16} cy={16} grid={32}>
      <path
        fill="currentColor"
        d="M16 2c-.504 0-.996.184-1.375.563l-2.813 2.843c-.152.082-.28.2-.374.344l-8.876 8.875a1.947 1.947 0 0 0 0 2.75l12.063 12.063a1.955 1.955 0 0 0 2.75 0l12.063-12.063a1.947 1.947 0 0 0 0-2.75L17.374 2.562A1.92 1.92 0 0 0 16 2m0 2.031L27.969 16L16 27.969L4.031 16l8.282-8.281l1.75 1.75A2 2 0 0 0 14 10c0 .738.402 1.371 1 1.719v8.562c-.598.348-1 .98-1 1.719a1.999 1.999 0 1 0 4 0c0-.738-.402-1.371-1-1.719v-7.843l3.063 3.062A2 2 0 0 0 22 18a2 2 0 0 0 1.999-2a2 2 0 0 0-2.5-1.938L17.937 10.5A2 2 0 0 0 16 8a2 2 0 0 0-.53.063l-1.75-1.75z"
      />
    </FillSvg>
  );
}

/** Lucide's `search`. Measured: 20 by 20, extent 20, centered at (12, 12). */
export function SearchIcon(props: IconProps) {
  return <Lucide {...props} icon={Search} extent={20} />;
}

/** Lucide's `case-sensitive` — the search field's "Match Case", VS Code's `Aa`. Wide and flat, so
 *  the long-side cap, which their geometric mean (16.25) would have drawn past the box: measured 22
 *  by 12 (stroke included), extent 20.23, centered at (12, 11). */
export function CaseSensitiveIcon(props: IconProps) {
  return <Lucide {...props} icon={CaseSensitive} extent={20.23} cy={11} />;
}

/** Lucide's `whole-word` — "Match Whole Word", VS Code's underlined `ab`. The long-side cap again,
 *  so it reads level with the `Aa` beside it: measured 22 by 14 (stroke included), extent 20.23,
 *  centered at (12, 13). */
export function WholeWordIcon(props: IconProps) {
  return <Lucide {...props} icon={WholeWord} extent={20.23} cy={13} />;
}

/** Lucide's `regex` — "Use Regular Expression", VS Code's `.*`. Measured: 20.33 by 20, extent
 *  20.16, centered at (12.17, 12). */
export function RegexIcon(props: IconProps) {
  return <Lucide {...props} icon={Regex} extent={20.16} cx={12.17} />;
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

/** Lucide's `wand` — a model's suggestion. Measured: 21 by 21, extent 21, centered at
 *  (12.5, 11.5). */
export function SparkleIcon(props: IconProps) {
  return <Lucide {...props} icon={Wand} extent={21} cx={12.5} cy={11.5} />;
}

/** Lucide's `play`, `SMALLER` like `CloseIcon`: measured 18 by 20 (stroke included), extent 18.98
 *  becomes 22.43, centered at (13, 12). */
export function PlayIcon(props: IconProps) {
  return <Lucide {...props} icon={Play} extent={18.98} scale={SMALLER} cx={13} />;
}

/** Lucide's `tag`. Measured: 22 by 22, extent 22, centered at (12, 12). */
export function TagIcon(props: IconProps) {
  return <Lucide {...props} icon={Tag} extent={22} />;
}

/** Lucide's `git-commit-horizontal`. Wide and flat, so the long-side cap: measured 20 by 8, extent
 *  18.39, centered at (12, 12). */
export function CommitIcon(props: IconProps) {
  return <Lucide {...props} icon={GitCommitHorizontal} extent={18.39} />;
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

/** Lucide's `trash` — discard, beside the stash's "put away". Its two inner lines sit inside the
 *  box. Measured: 20 by 22; the geometric mean would clip the bottom, so the long-axis cap: extent
 *  20.98, centered at (12, 12). */
export function DiscardIcon(props: IconProps) {
  return <Lucide {...props} icon={Trash} extent={20.98} />;
}

/** Lucide's `arrow-up`. Measured: 16 by 16, extent 16, centered at (12, 12). */
export function ArrowUpIcon(props: IconProps) {
  return <Lucide {...props} icon={ArrowUp} extent={16} />;
}

/** Lucide's `arrow-down`. Measured: 16 by 16, extent 16, centered at (12, 12). */
export function ArrowDownIcon(props: IconProps) {
  return <Lucide {...props} icon={ArrowDown} extent={16} />;
}

/** Lucide's `refresh-cw` — fetch. Measured: 20 by 20, extent 20, centered at (12, 12). */
export function SyncIcon(props: IconProps) {
  return <Lucide {...props} icon={RefreshCw} extent={20} />;
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
 * Lucide's `circle-alert` — what cannot work as it stands: a tab whose agent cannot start, a
 * sbx-settings row or tab. Measured: 22 by 22, extent 22, centered at (12, 12).
 * Its own color, not `--vscode-focusBorder`: see `.session-mark-error`.
 */
export function CircleAlertIcon(props: IconProps) {
  return <Lucide {...props} icon={CircleAlert} extent={22} />;
}

/** Lucide's `message-square` — a finished turn nobody has seen yet. Measured: 22 by 21, extent
 *  21.49, centered at (12, 12.5). */
export function CommentIcon(props: IconProps) {
  return <Lucide {...props} icon={MessageSquare} extent={21.49} cy={12.5} />;
}

export function RemoteIcon(props: IconProps) {
  return (
    <Svg {...props} extent={11.34}>
      <circle cx="8" cy="8" r="5" />
      <path d="M3 8h10M8 3c1.5 1.7 1.5 8.3 0 10M8 3c-1.5 1.7-1.5 8.3 0 10" />
    </Svg>
  );
}

/** Lucide's `settings`. Measured: 20 by 22, extent 20.91, centered at (12, 12). Drawn `LARGER`: a
 *  gear is mostly gaps and reads small beside the git mark. */
export function GearIcon(props: IconProps) {
  return <Lucide {...props} icon={Settings} extent={20.91} scale={LARGER} />;
}

/** Lucide's `file-braces` — the files view. Measured: 18 by 22; the geometric mean would clip the
 *  bottom, so the long-axis cap: extent 20.23, centered at (12, 12). */
export function FilesIcon(props: IconProps) {
  return <Lucide {...props} icon={FileBraces} extent={20.23} />;
}

/** The EXPLORER header's "New File...": Lucide's `file-plus`. Measured, stroke included: 18 by 22;
 *  the geometric mean would clip the bottom, so the long-axis cap: extent 20.23, centered at
 *  (12, 12). */
export function NewFileIcon(props: IconProps) {
  return <Lucide {...props} icon={FilePlus} extent={20.23} />;
}

/** The EXPLORER header's "New Folder...": Lucide's `folder-plus`. Measured: 22 by 19, square enough
 *  for the uncapped geometric mean: extent 20.45, centered at (12, 11.5). */
export function NewFolderIcon(props: IconProps) {
  return <Lucide {...props} icon={FolderPlus} extent={20.45} cy={11.5} />;
}

/** "Collapse Folders in Explorer": Lucide's `copy-minus`. Measured: 22 by 22, extent 22, centered
 *  at (12, 12). */
export function CollapseAllIcon(props: IconProps) {
  return <Lucide {...props} icon={CopyMinus} extent={22} />;
}

/** The results pane's "Expand All": Lucide's `copy-plus`, `copy-minus` with one line more, which
 *  sits inside its box — the same extent. */
export function ExpandAllIcon(props: IconProps) {
  return <Lucide {...props} icon={CopyPlus} extent={22} />;
}

/** Both files-pane headers' "Clear": Lucide's `list-x`. Wide, so the long-side cap: measured 19.5
 *  by 16 (stroke included), extent 17.93, centered at (11.75, 12). */
export function ClearIcon(props: IconProps) {
  return <Lucide {...props} icon={ListX} extent={17.93} cx={11.75} />;
}

/** Lucide's `save`. Measured: 20 by 20, extent 20, centered at (12, 12). */
export function SaveIcon(props: IconProps) {
  return <Lucide {...props} icon={Save} extent={20} />;
}

/** Lucide's `eye` — a Markdown preview. Wide, so the long-side cap: measured 22 by 16 (stroke
 *  included), extent 20.23, centered at (12, 12). */
export function EyeIcon(props: IconProps) {
  return <Lucide {...props} icon={Eye} extent={20.23} />;
}

/** Lucide's `git-compare` — the editor tab's diff toggle. Square: measured 20 by 20 (stroke
 *  included), extent 20, centered at (12, 12). */
export function CompareIcon(props: IconProps) {
  return <Lucide {...props} icon={GitCompare} extent={20} />;
}
