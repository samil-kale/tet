import { useCallback, useMemo, useState, type RefObject } from "react";
import { useLatest } from "./use-latest";
import { reorder } from "./drag-reorder";
import { usePaneChoice, usePaneOrder, usePaneSet, usePaneSize } from "./layout-storage";
import { MIN_PANE_WIDTH } from "./Sash";

/** A lane, left of the terminals: the projects, git or files. */
export type Lane = "projects" | "git" | "files";

/** The lanes' order until the user drags one elsewhere. */
export const LANES: readonly Lane[] = ["projects", "git", "files"];

/** The free lane: one of them, or none while it is in. */
const FREE_CHOICES: readonly (Lane | "none")[] = [...LANES, "none"];

/** A lane's width and how its sash sets it. */
type LaneWidth = [number, (size: number) => void];

/** The lanes, their widths and slide, and the ways they open. */
interface Lanes {
  /** Every lane out: the pinned ones and the free one. */
  openLanes: ReadonlySet<Lane>;
  pinnedLanes: ReadonlySet<Lane>;
  /** The pinned lanes in their order, left to right. */
  pinnedOrder: readonly Lane[];
  /** The lanes not pinned in the strip's toggles' order. */
  toggleOrder: readonly Lane[];
  /** The one lane out not pinned, which the strip's toggles show, replace and hide. */
  freeLane: Lane | null;
  widthOf: (lane: Lane) => LaneWidth;
  /** The lanes whose width transitions now (`.lane.sliding`). */
  slidingLanes: ReadonlySet<Lane>;
  stopSliding: (lane: Lane) => void;
  toggleLane: (lane: Lane) => void;
  togglePin: (lane: Lane) => void;
  /** A pinned lane dragged from `from` to insertion index `to` of `pinnedOrder`. */
  movePinned: (from: number, to: number) => void;
  /** A toggle dragged from `from` to insertion index `to` of `toggleOrder`. */
  moveToggle: (from: number, to: number) => void;
  showChanges: (key: string) => void;
}

/**
 * Which lanes are pinned and which one is free, and their widths — remembered like a pane size.
 * The strip's toggles drive the free lane alone, one at a time as VS Code's Explorer and Source
 * Control: the next replaces it. A pinned lane is out until unpinned from its headers' menu, when
 * it slides in; its toggle is gone from the strip meanwhile. The free lane is one width whichever
 * it is, a pinned one keeps its own, and a pin hands the free lane's width over so it stays put.
 * The order is the user's, one list for all lanes: a pin takes the lane to the end of the pinned
 * ones, beside the free one where it stood, an unpin to the front of the toggles; dragging a
 * pinned lane's header or a toggle moves it among its own. `activeKeyRef` is the repository or
 * worktree in front, `setActiveKey` how a row's git mark brings its own there.
 */
export function useLanes(
  activeKeyRef: RefObject<string | null>,
  setActiveKey: (key: string) => void
): Lanes {
  // Nothing stored yet: the projects lane stands pinned.
  const [pinnedLanes, setPinnedLanes] = usePaneSet("lanes-pinned", LANES, ["projects"]);
  const [order, setOrder] = usePaneOrder("lanes-order", LANES);
  const pinnedOrder = useMemo(() => order.filter((lane) => pinnedLanes.has(lane)), [order, pinnedLanes]);
  const toggleOrder = useMemo(() => order.filter((lane) => !pinnedLanes.has(lane)), [order, pinnedLanes]);
  const [freeChoice, setFreeChoice] = usePaneChoice("lanes-free", FREE_CHOICES, "projects");
  // A lane pinned since it was stored is no longer free.
  const freeLane = freeChoice === "none" || pinnedLanes.has(freeChoice) ? null : freeChoice;
  const openLanes = useMemo(
    () => new Set<Lane>([...pinnedLanes, ...(freeLane ? [freeLane] : [])]),
    [pinnedLanes, freeLane]
  );
  const pinnedWidths: Record<Lane, LaneWidth> = {
    projects: usePaneSize("lane-width-projects", 300, MIN_PANE_WIDTH),
    git: usePaneSize("lane-width-git", 300, MIN_PANE_WIDTH),
    files: usePaneSize("lane-width-files", 300, MIN_PANE_WIDTH)
  };
  const freeWidth = usePaneSize("lane-width-free", 300, MIN_PANE_WIDTH);
  const widthOf = (lane: Lane): LaneWidth => (pinnedLanes.has(lane) ? pinnedWidths[lane] : freeWidth);
  /** Read on a click, so the callbacks — and every view handed them — stay the same across one. */
  const freeRef = useLatest(freeLane);
  const pinnedRef = useLatest(pinnedLanes);
  const widthsRef = useLatest({ pinnedWidths, freeWidth });
  const ordersRef = useLatest({ pinnedOrder, toggleOrder });
  /** The one way the order is written: the pinned lanes, then the toggles. */
  const writeOrder = useCallback(
    (pinned: readonly Lane[], toggles: readonly Lane[]) => setOrder([...pinned, ...toggles]),
    [setOrder]
  );
  /**
   * Gates a lane's width transition to its slide alone — a lane stays in the DOM at width 0
   * while in, so opening and closing both transition — and its sash sets the same width, where an
   * animated one would lag the pointer. Set by what opens or closes a lane, cleared once its
   * transition ends; a lane replacing the free one slides nothing.
   */
  const [slidingLanes, setSlidingLanes] = useState<ReadonlySet<Lane>>(() => new Set());
  const stopSliding = useCallback(
    (lane: Lane) =>
      setSlidingLanes((current) => (current.has(lane) ? new Set([...current].filter((entry) => entry !== lane)) : current)),
    []
  );
  const slide = useCallback((lane: Lane) => setSlidingLanes((current) => new Set([...current, lane])), []);

  /** Shows that lane as the free one, or slides it in when it is already there. A pinned one is
   *  out and stays. */
  const toggleLane = useCallback(
    (lane: Lane) => {
      if (pinnedRef.current.has(lane)) {
        return;
      }
      const free = freeRef.current;
      setFreeChoice(free === lane ? "none" : lane);
      if (free === null || free === lane) {
        slide(lane);
      }
    },
    [pinnedRef, freeRef, setFreeChoice, slide]
  );
  /** Pinning the free lane keeps it where it is, with its width; unpinning a lane slides it in,
   *  the free one staying. */
  const togglePin = useCallback(
    (lane: Lane) => {
      const pinned = pinnedRef.current;
      const free = freeRef.current;
      const widths = widthsRef.current;
      const orders = ordersRef.current;
      const others = (lanes: readonly Lane[]) => lanes.filter((entry) => entry !== lane);
      if (!pinned.has(lane)) {
        widths.pinnedWidths[lane][1](widths.freeWidth[0]);
        setPinnedLanes(new Set([...pinned, lane]));
        writeOrder([...orders.pinnedOrder, lane], others(orders.toggleOrder));
        if (free === lane) {
          setFreeChoice("none");
        } else {
          slide(lane);
        }
        return;
      }
      setPinnedLanes(new Set(others([...pinned])));
      writeOrder(others(orders.pinnedOrder), [lane, ...orders.toggleOrder]);
      slide(lane);
    },
    [pinnedRef, freeRef, widthsRef, ordersRef, setPinnedLanes, writeOrder, setFreeChoice, slide]
  );
  const movePinned = useCallback(
    (from: number, to: number) => {
      const orders = ordersRef.current;
      writeOrder(reorder(orders.pinnedOrder, from, to), orders.toggleOrder);
    },
    [ordersRef, writeOrder]
  );
  const moveToggle = useCallback(
    (from: number, to: number) => {
      const orders = ordersRef.current;
      writeOrder(orders.pinnedOrder, reorder(orders.toggleOrder, from, to));
    },
    [ordersRef, writeOrder]
  );
  /**
   * A row's git mark: switches to the repository or worktree and slides git out; on the one shown,
   * the strip's toggle.
   */
  const showChanges = useCallback(
    (key: string) => {
      setActiveKey(key);
      if (key === activeKeyRef.current || (!pinnedRef.current.has("git") && freeRef.current !== "git")) {
        toggleLane("git");
      }
    },
    [activeKeyRef, setActiveKey, pinnedRef, freeRef, toggleLane]
  );

  return {
    openLanes,
    pinnedLanes,
    pinnedOrder,
    toggleOrder,
    freeLane,
    widthOf,
    slidingLanes,
    stopSliding,
    toggleLane,
    togglePin,
    movePinned,
    moveToggle,
    showChanges
  };
}
