import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  CircleX,
  Columns2,
  File,
  FileCode,
  FilePlus,
  FolderCode,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitGraph,
  GitCommitHorizontal,
  GitCompare,
  Globe,
  Info,
  Landmark,
  List,
  ListTree,
  ListX,
  LoaderCircle,
  LogIn,
  MessageCircleCheck,
  MessageCircleQuestionMark,
  MessageCircleX,
  MessageSquareText,
  Package,
  Play,
  Plus,
  RefreshCw,
  Regex,
  Save,
  Search,
  Settings,
  Shield,
  Tag,
  Undo2,
  User,
  View,
  Wand,
  WholeWord,
  X,
  type LucideIcon,
} from "lucide-react";
import type { NoticeSeverity } from "../../shared/types/app";

export interface IconProps {
  className?: string;
}

/** The share of its 16-unit box every icon's drawing is cut to cover. */
const TARGET_EXTENT = 12.8;
const GRID = 16;

/**
 * Fits an icon by how much of its grid it actually draws on, since icons cover their grids
 * unequally. Each declares its extent — the side of its drawing's bounding box, half a stroke
 * included — and the viewBox is cropped to put that extent at TARGET_EXTENT. `strokeWidth` scales
 * by the same factor, or the crop would thicken every enlarged stroke. One meant to read smaller
 * or larger than its neighbours declares a wider or narrower extent, saying why at its site.
 *
 * An extent is the **geometric mean** of the box's sides, not the longer side, capped at about 87%
 * of the box in the long axis so a long thin icon does not outgrow its place.
 *
 * The box is `--icon-size`, stated in CSS. A new icon comes from lucide-react first (`Lucide`); a
 * hand drawing (`Svg`, or `FillSvg` for a fill-only one) is for what Lucide has no match for.
 */
function geometry(extent: number, cx: number, cy: number, grid: number, stroke: number) {
  const side = (extent * grid) / ((TARGET_EXTENT / GRID) * grid);
  return {
    viewBox: `${cx - side / 2} ${cy - side / 2} ${side} ${side}`,
    strokeWidth: (stroke * side) / grid,
  };
}

/** `Svg`'s box for a fill-only icon on its own grid (git's mark, agent-icons.tsx): the same
 *  fitting, nothing stroked. */
export function FillSvg({
  className,
  extent,
  cx,
  cy,
  grid,
  shapeRendering,
  children,
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
      width="14"
      height="14"
      viewBox={geometry(extent, cx, cy, grid, 0).viewBox}
      shapeRendering={shapeRendering}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * `extent` and the centre `cx`/`cy` are the drawing's, on the 16 grid. Also the stroked agent
 * icons' box (agent-icons.tsx).
 */
export function Svg({
  children,
  className,
  extent = TARGET_EXTENT,
  cx = 8,
  cy = 8,
  stroke = 1.5,
}: IconProps & {
  children: React.ReactNode;
  extent?: number;
  cx?: number;
  cy?: number;
  /** The drawing's own stroke on the 16 grid, scaled by the crop like everything else. */
  stroke?: number;
}) {
  const { viewBox, strokeWidth } = geometry(extent, cx, cy, GRID, stroke);
  return (
    <svg
      className={className}
      // Fallback only: CSS `--icon-size` renders over these in a flex container; keep them equal.
      width="14"
      height="14"
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
 * A lucide-react icon as Lucide draws it: its whole 24-unit grid and its stroke of 2, filling the
 * box. One that must read otherwise — leading a row, or smaller beside its neighbours — is cropped
 * like `Svg` instead: an `extent`, centred where most of them are unless `cx`/`cy` say otherwise,
 * and a heavier `stroke` if it says so. The extents hold for the paths lucide-react ships.
 */
function Lucide({
  icon: Icon,
  className,
  extent,
  cx = 12,
  cy = 12,
  stroke = 2,
}: IconProps & {
  icon: LucideIcon;
  extent?: number;
  cx?: number;
  cy?: number;
  stroke?: number;
}) {
  // `size` is the fallback only, as `Svg`'s width and height; a `viewBox` overrides lucide's own.
  if (extent === undefined) {
    return <Icon className={className} size={14} />;
  }
  const { viewBox, strokeWidth } = geometry(extent, cx, cy, 24, stroke);
  return <Icon className={className} size={14} viewBox={viewBox} strokeWidth={strokeWidth} />;
}

/** Lucide's `plus`, stroked heavier to lead a row. */
export function PlusIcon(props: IconProps) {
  return <Lucide {...props} icon={Plus} extent={14.79} stroke={2.3} />;
}

/** Lucide's `x`, drawn two pixels under the shared size. */
export function CloseIcon(props: IconProps) {
  return <Lucide {...props} icon={X} extent={16.9} />;
}

/** Lucide's `log-in` — sign in with an SBX access token. */
export function LogInIcon(props: IconProps) {
  return <Lucide {...props} icon={LogIn} />;
}

/** Lucide's `check` — the SBX access token signed in with. */
export function CheckIcon(props: IconProps) {
  return <Lucide {...props} icon={Check} />;
}

/** Lucide's `shield` — a project, or a tab, sandboxed by sbx. A tab's badge sizes its own box. */
export function ShieldIcon(props: IconProps) {
  return <Lucide {...props} icon={Shield} />;
}

/** Lucide's `landmark` — sbx's policy governed by an organization. */
export function LandmarkIcon(props: IconProps) {
  return <Lucide {...props} icon={Landmark} />;
}

/** Lucide's `git-compare` — the project row's mark for uncommitted changes. */
export function ChangesIcon(props: IconProps) {
  return <Lucide {...props} icon={GitCompare} />;
}

const SEVERITY_ICONS: Record<NoticeSeverity, LucideIcon> = {
  error: CircleX,
  warning: CircleAlert,
  info: Info,
};

/**
 * Notice severities in a shared circle — Lucide's `circle-x`, `circle-alert`, `info` — so the
 * shape carries the meaning as well as the color.
 */
export function SeverityIcon({ severity, ...props }: IconProps & { severity: NoticeSeverity }) {
  return <Lucide {...props} icon={SEVERITY_ICONS[severity]} />;
}

/** Lucide's `git-branch`. */
export function BranchIcon(props: IconProps) {
  return <Lucide {...props} icon={GitBranch} />;
}

/** Lucide's `git-graph` — BRANCHES' switch to the commit graph. */
export function GraphIcon(props: IconProps) {
  return <Lucide {...props} icon={GitGraph} />;
}

/** Lucide's `folder-code` — the projects lane. */
export function ProjectsIcon(props: IconProps) {
  return <Lucide {...props} icon={FolderCode} />;
}

/** Lucide's `folder-git-2` — a worktree. */
export function WorktreeIcon(props: IconProps) {
  return <Lucide {...props} icon={FolderGit2} />;
}

/**
 * Git's mark as a hollow outline (`git-alt`): one filled path on a 32-unit grid. Nearly the whole
 * box, as a diamond inks half its bounding box; larger would clip the tips.
 */
export function GitIcon(props: IconProps) {
  return (
    <FillSvg className={props.className} extent={22.75} cx={16} cy={16} grid={32}>
      <path
        fill="currentColor"
        d="M16 2c-.504 0-.996.184-1.375.563l-2.813 2.843c-.152.082-.28.2-.374.344l-8.876 8.875a1.947 1.947 0 0 0 0 2.75l12.063 12.063a1.955 1.955 0 0 0 2.75 0l12.063-12.063a1.947 1.947 0 0 0 0-2.75L17.374 2.562A1.92 1.92 0 0 0 16 2m0 2.031L27.969 16L16 27.969L4.031 16l8.282-8.281l1.75 1.75A2 2 0 0 0 14 10c0 .738.402 1.371 1 1.719v8.562c-.598.348-1 .98-1 1.719a1.999 1.999 0 1 0 4 0c0-.738-.402-1.371-1-1.719v-7.843l3.063 3.062A2 2 0 0 0 22 18a2 2 0 0 0 1.999-2a2 2 0 0 0-2.5-1.938L17.937 10.5A2 2 0 0 0 16 8a2 2 0 0 0-.53.063l-1.75-1.75z"
      />
    </FillSvg>
  );
}

/** Lucide's `search`. */
export function SearchIcon(props: IconProps) {
  return <Lucide {...props} icon={Search} />;
}

/** Lucide's `case-sensitive` — the search field's "Match Case", VS Code's `Aa`. */
export function CaseSensitiveIcon(props: IconProps) {
  return <Lucide {...props} icon={CaseSensitive} />;
}

/** Lucide's `whole-word` — "Match Whole Word", VS Code's underlined `ab`. */
export function WholeWordIcon(props: IconProps) {
  return <Lucide {...props} icon={WholeWord} />;
}

/** Lucide's `regex` — "Use Regular Expression", VS Code's `.*`. */
export function RegexIcon(props: IconProps) {
  return <Lucide {...props} icon={Regex} />;
}

/** Lucide's `message-square-text` — the GRAPH's search in commit messages. */
export function MessageIcon(props: IconProps) {
  return <Lucide {...props} icon={MessageSquareText} />;
}

/** Lucide's `user` — the GRAPH's search in authors. */
export function UserIcon(props: IconProps) {
  return <Lucide {...props} icon={User} />;
}

/** Lucide's `file` — the GRAPH's search in paths. */
export function PathIcon(props: IconProps) {
  return <Lucide {...props} icon={File} />;
}

/** Lucide's `chevron-down` or `chevron-right`. */
export function ChevronIcon({ expanded, ...props }: IconProps & { expanded: boolean }) {
  return <Lucide {...props} icon={expanded ? ChevronDown : ChevronRight} />;
}

/** Lucide's `loader-circle`, spun (`spinning`) about its centre as a tab's working mark
 *  (`TabMark`). */
export function SpinnerIcon(props: IconProps) {
  return <Lucide {...props} icon={LoaderCircle} />;
}

/** Lucide's `wand` — a model's suggestion. */
export function SparkleIcon(props: IconProps) {
  return <Lucide {...props} icon={Wand} />;
}

/** Lucide's `play`, two pixels under like `CloseIcon`. */
export function PlayIcon(props: IconProps) {
  return <Lucide {...props} icon={Play} extent={22.43} cx={13} />;
}

/** Lucide's `tag`. */
export function TagIcon(props: IconProps) {
  return <Lucide {...props} icon={Tag} />;
}

/** Lucide's `git-commit-horizontal`. */
export function CommitIcon(props: IconProps) {
  return <Lucide {...props} icon={GitCommitHorizontal} />;
}

/** Lucide's `package` — a stash. */
export function StashIcon(props: IconProps) {
  return <Lucide {...props} icon={Package} />;
}

/** Lucide's `undo-2` — discard, as IntelliJ's rollback. */
export function DiscardIcon(props: IconProps) {
  return <Lucide {...props} icon={Undo2} />;
}

/** Lucide's `arrow-up`, drawn larger than Lucide's own. */
export function ArrowUpIcon(props: IconProps) {
  return <Lucide {...props} icon={ArrowUp} extent={16.7} />;
}

/** Lucide's `arrow-down`, drawn larger as `arrow-up`. */
export function ArrowDownIcon(props: IconProps) {
  return <Lucide {...props} icon={ArrowDown} extent={16.7} />;
}

/** Lucide's `refresh-cw` — fetch. */
export function SyncIcon(props: IconProps) {
  return <Lucide {...props} icon={RefreshCw} />;
}

/**
 * Lucide's `message-circle-question-mark` — a session stopped on an unanswered question, on its tab and
 * project row. Shares the mark slot with the bubble and the spinner, so it must differ from them at
 * a glance.
 */
export function QuestionIcon(props: IconProps) {
  return <Lucide {...props} icon={MessageCircleQuestionMark} />;
}

/**
 * Lucide's `circle-alert` — what cannot work as it stands in a dialog: its row or tab (`RowMark`,
 * `DialogTab.mark`). Its own color, not `--tet-focusBorder`: see `.tab-mark-error`.
 */
export function CircleAlertIcon(props: IconProps) {
  return <Lucide {...props} icon={CircleAlert} />;
}

/** Lucide's `message-circle-x` — a tab whose agent cannot start, among the other tab marks'
 *  bubbles. Its own color, as `CircleAlertIcon`. */
export function TabErrorIcon(props: IconProps) {
  return <Lucide {...props} icon={MessageCircleX} />;
}

/** Lucide's `message-circle-check` — a finished turn nobody has seen yet. */
export function CommentIcon(props: IconProps) {
  return <Lucide {...props} icon={MessageCircleCheck} />;
}

/** Lucide's `globe` — a remote. */
export function RemoteIcon(props: IconProps) {
  return <Lucide {...props} icon={Globe} />;
}

/** Lucide's `settings`. */
export function GearIcon(props: IconProps) {
  return <Lucide {...props} icon={Settings} />;
}

/** Lucide's `file-code` — the files lane. */
export function FilesIcon(props: IconProps) {
  return <Lucide {...props} icon={FileCode} />;
}

/** The EXPLORER header's "New File...": Lucide's `file-plus`. */
export function NewFileIcon(props: IconProps) {
  return <Lucide {...props} icon={FilePlus} />;
}

/** The EXPLORER header's "New Folder...": Lucide's `folder-plus`. */
export function NewFolderIcon(props: IconProps) {
  return <Lucide {...props} icon={FolderPlus} />;
}

/** A tree header's "Collapse All", as IntelliJ's: Lucide's `chevrons-down-up`. */
export function CollapseAllIcon(props: IconProps) {
  return <Lucide {...props} icon={ChevronsDownUp} />;
}

/** A tree header's "Expand All", as IntelliJ's: Lucide's `chevrons-up-down`, drawn larger than Lucide's
 *  own. */
export function ExpandAllIcon(props: IconProps) {
  return <Lucide {...props} icon={ChevronsUpDown} extent={17.38} />;
}

/** Both files-lane headers' "Clear": Lucide's `list-x`. */
export function ClearIcon(props: IconProps) {
  return <Lucide {...props} icon={ListX} />;
}

/** LOCAL CHANGES' "View as List": Lucide's `list`. */
export function ListIcon(props: IconProps) {
  return <Lucide {...props} icon={List} />;
}

/** LOCAL CHANGES' "View as Tree": Lucide's `list-tree`. */
export function ListTreeIcon(props: IconProps) {
  return <Lucide {...props} icon={ListTree} />;
}

/** Lucide's `save`. */
export function SaveIcon(props: IconProps) {
  return <Lucide {...props} icon={Save} />;
}

/** Lucide's `view` — a Markdown preview. */
export function ViewIcon(props: IconProps) {
  return <Lucide {...props} icon={View} />;
}

/** Lucide's `git-compare` — the editor tab's diff toggle. */
export function CompareIcon(props: IconProps) {
  return <Lucide {...props} icon={GitCompare} />;
}

/** Lucide's `columns-2` — the editor tab's side-by-side toggle. */
export function SideBySideIcon(props: IconProps) {
  return <Lucide {...props} icon={Columns2} />;
}
