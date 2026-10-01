import { useCallback, useMemo, useState, type RefObject } from "react";
import { useLatest } from "./use-latest";
import { usePaneChoice, usePaneSet, usePaneSize } from "./layout-storage";
import { MIN_PANE_WIDTH } from "./Sash";

/** A view of the side pane, each a column of its own. */
export type SideView = "projects" | "git" | "files";

/** The columns' order, pinned ones first: the strip's toggles'. */
export const SIDE_VIEWS: readonly SideView[] = ["projects", "git", "files"];

/** What the free column holds: a view, or none while it is in. */
const FREE_CHOICES: readonly (SideView | "none")[] = [...SIDE_VIEWS, "none"];

/** A column's width and how its sash sets it. */
type ColumnWidth = [number, (size: number) => void];

/** The side pane's columns, their widths and slide, and the ways views open them. */
interface SidePane {
  /** Every column out: the pinned ones and the free one. */
  openViews: ReadonlySet<SideView>;
  pinnedViews: ReadonlySet<SideView>;
  /** The one view out not pinned, which the strip's toggles show, replace and hide. */
  freeView: SideView | null;
  widthOf: (view: SideView) => ColumnWidth;
  /** The columns whose width transitions now (`.side-pane.sliding`). */
  slidingViews: ReadonlySet<SideView>;
  stopSliding: (view: SideView) => void;
  toggleSideView: (view: SideView) => void;
  togglePin: (view: SideView) => void;
  showChanges: (key: string) => void;
}

/**
 * Which views are pinned and which one is free, and their widths — remembered like a pane size.
 * The strip's toggles drive the free column alone, one view at a time as VS Code's Explorer and
 * Source Control: the next replaces it. A pinned view is out until unpinned from its headers' menu,
 * when its column slides in; its toggle is gone from the strip meanwhile. The free column is one
 * width whichever view it shows, a pinned one keeps its own, and a pin hands the column's width
 * over so it stays put. `activeKeyRef` is the repository or worktree in front,
 * `setActiveKey` how a row's git mark brings its own there.
 */
export function useSidePane(
  activeKeyRef: RefObject<string | null>,
  setActiveKey: (key: string) => void
): SidePane {
  const [pinnedViews, setPinnedViews] = usePaneSet("side-pane-pinned", SIDE_VIEWS, []);
  const [freeChoice, setFreeChoice] = usePaneChoice("side-pane-free", FREE_CHOICES, "projects");
  // A view pinned since it was stored is no longer free.
  const freeView = freeChoice === "none" || pinnedViews.has(freeChoice) ? null : freeChoice;
  const openViews = useMemo(
    () => new Set<SideView>([...pinnedViews, ...(freeView ? [freeView] : [])]),
    [pinnedViews, freeView]
  );
  const pinnedWidths: Record<SideView, ColumnWidth> = {
    projects: usePaneSize("side-width-projects", 300, MIN_PANE_WIDTH),
    git: usePaneSize("side-width-git", 300, MIN_PANE_WIDTH),
    files: usePaneSize("side-width-files", 300, MIN_PANE_WIDTH)
  };
  const freeWidth = usePaneSize("side-width-free", 300, MIN_PANE_WIDTH);
  const widthOf = (view: SideView): ColumnWidth => (pinnedViews.has(view) ? pinnedWidths[view] : freeWidth);
  /** Read on a click, so the callbacks — and every view handed them — stay the same across one. */
  const freeRef = useLatest(freeView);
  const pinnedRef = useLatest(pinnedViews);
  const widthsRef = useLatest({ pinnedWidths, freeWidth });
  /**
   * Gates a column's width transition to its slide alone — a column stays in the DOM at width 0
   * while in, so opening and closing both transition — and its sash sets the same width, where an
   * animated one would lag the pointer. Set by what opens or closes a column, cleared once its
   * transition ends; a view replacing the free one slides nothing.
   */
  const [slidingViews, setSlidingViews] = useState<ReadonlySet<SideView>>(() => new Set());
  const stopSliding = useCallback(
    (view: SideView) =>
      setSlidingViews((current) => (current.has(view) ? new Set([...current].filter((entry) => entry !== view)) : current)),
    []
  );
  const slide = useCallback((view: SideView) => setSlidingViews((current) => new Set([...current, view])), []);

  /** Shows that view in the free column, or slides it in when it is already there. A pinned one is
   *  out and stays. */
  const toggleSideView = useCallback(
    (view: SideView) => {
      if (pinnedRef.current.has(view)) {
        return;
      }
      const free = freeRef.current;
      setFreeChoice(free === view ? "none" : view);
      if (free === null || free === view) {
        slide(view);
      }
    },
    [pinnedRef, freeRef, setFreeChoice, slide]
  );
  /** Pinning the free view keeps it where it is, with its width; unpinning a view slides its column
   *  in, the free one staying. */
  const togglePin = useCallback(
    (view: SideView) => {
      const pinned = pinnedRef.current;
      const free = freeRef.current;
      const widths = widthsRef.current;
      if (!pinned.has(view)) {
        widths.pinnedWidths[view][1](widths.freeWidth[0]);
        setPinnedViews(new Set([...pinned, view]));
        if (free === view) {
          setFreeChoice("none");
        } else {
          slide(view);
        }
        return;
      }
      setPinnedViews(new Set([...pinned].filter((entry) => entry !== view)));
      slide(view);
    },
    [pinnedRef, freeRef, widthsRef, setPinnedViews, setFreeChoice, slide]
  );
  /**
   * A row's git mark: switches to the repository or worktree and slides git out; on the one shown,
   * the strip's toggle.
   */
  const showChanges = useCallback(
    (key: string) => {
      setActiveKey(key);
      if (key === activeKeyRef.current || (!pinnedRef.current.has("git") && freeRef.current !== "git")) {
        toggleSideView("git");
      }
    },
    [activeKeyRef, setActiveKey, pinnedRef, freeRef, toggleSideView]
  );

  return { openViews, pinnedViews, freeView, widthOf, slidingViews, stopSliding, toggleSideView, togglePin, showChanges };
}
