import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { errorMessage } from "../../shared/errors";
import { laneOrders, laneSettings, LANES, withLanePinned, type Lane, type LaneSettings } from "../../shared/types/settings";
import { useLatest } from "../ui/use-latest";
import { reorder } from "../ui/drag-reorder";
import { useStoredChoice, useStoredSize } from "../ui/layout-storage";
import { notify } from "../ui/Notices";
import { MIN_AREA_WIDTH } from "../ui/Sash";

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
  showChanges: (refKey: string) => void;
}

/**
 * Pins and order are settings (`appearance.lanes`, `initial` as read at the start); which lane is
 * free and the widths are layout storage. The strip's toggles drive the free lane alone, one at a
 * time as VS Code's Explorer and Source Control. `activeRefKeyRef` is the active repository or
 * worktree, `setActiveRefKey` how a row's git mark makes its own active.
 */
export function useLanes(
  initial: LaneSettings,
  activeRefKeyRef: RefObject<string | null>,
  setActiveRefKey: (refKey: string) => void,
): Lanes {
  const [lanes, setLanes] = useState(initial);
  // Set by `tet-ctl`, or the window's own write coming back, which keeps what is shown.
  useEffect(
    () =>
      window.tet.onLanes((stored) =>
        setLanes((current) =>
          current.length === stored.length &&
          current.every((entry, i) => entry.lane === stored[i].lane && entry.pinned === stored[i].pinned)
            ? current
            : stored,
        ),
      ),
    [],
  );
  const { pinned: pinnedOrder, toggles: toggleOrder } = useMemo(() => laneOrders(lanes), [lanes]);
  const pinnedLanes = useMemo(() => new Set(pinnedOrder), [pinnedOrder]);
  const [freeChoice, setFreeChoice] = useStoredChoice("lanes-free", FREE_CHOICES, "projects");
  // A lane pinned since it was stored is no longer free.
  const freeLane = freeChoice === "none" || pinnedLanes.has(freeChoice) ? null : freeChoice;
  const openLanes = useMemo(() => new Set<Lane>([...pinnedLanes, ...(freeLane ? [freeLane] : [])]), [pinnedLanes, freeLane]);
  const pinnedWidths: Record<Lane, LaneWidth> = {
    projects: useStoredSize("lane-width-projects", 300, MIN_AREA_WIDTH),
    git: useStoredSize("lane-width-git", 300, MIN_AREA_WIDTH),
    files: useStoredSize("lane-width-files", 300, MIN_AREA_WIDTH),
  };
  const freeWidth = useStoredSize("lane-width-free", 300, MIN_AREA_WIDTH);
  const widthOf = (lane: Lane): LaneWidth => (pinnedLanes.has(lane) ? pinnedWidths[lane] : freeWidth);
  /** Read on a click, so the callbacks — and every view handed them — stay the same across one. */
  const live = useLatest({ lanes, pinnedLanes, pinnedOrder, toggleOrder, freeLane, pinnedWidths, freeWidth });
  /** The one way the lanes are written. Shown at once; a failed write is told, and the settings
   *  keep what the disk has. */
  const writeLanes = useCallback((next: LaneSettings) => {
    setLanes(next);
    window.tet.settings
      .patch({ appearance: { lanes: next } })
      .catch((error: unknown) => notify("error", `Could not keep the lanes: ${errorMessage(error)}`));
  }, []);
  /**
   * Gates a lane's width transition to its slide alone — a lane stays in the DOM at width 0
   * while in, so opening and closing both transition — and its sash sets the same width, where an
   * animated one would lag the pointer. Set by what opens or closes a lane, cleared once its
   * transition ends; a lane replacing the free one slides nothing.
   */
  const [slidingLanes, setSlidingLanes] = useState<ReadonlySet<Lane>>(() => new Set());
  const stopSliding = useCallback(
    (lane: Lane) =>
      setSlidingLanes((current) => {
        if (!current.has(lane)) {
          return current;
        }
        const next = new Set(current);
        next.delete(lane);
        return next;
      }),
    [],
  );
  const slide = useCallback((lane: Lane) => setSlidingLanes((current) => new Set([...current, lane])), []);

  /** Shows that lane as the free one, or slides it in when it is already there. A pinned one is
   *  out and stays. */
  const toggleLane = useCallback(
    (lane: Lane) => {
      const { pinnedLanes: pinned, freeLane: free } = live.current;
      if (pinned.has(lane)) {
        return;
      }
      setFreeChoice(free === lane ? "none" : lane);
      if (free === null || free === lane) {
        slide(lane);
      }
    },
    [live, setFreeChoice, slide],
  );
  /** A pin takes the lane to the end of the pinned ones (`withLanePinned`): the free lane keeps its
   *  place and hands over its width. An unpinned lane slides in, the free one staying. */
  const togglePin = useCallback(
    (lane: Lane) => {
      const now = live.current;
      const pin = !now.pinnedLanes.has(lane);
      writeLanes(withLanePinned(now.lanes, lane, pin));
      if (pin) {
        now.pinnedWidths[lane][1](now.freeWidth[0]);
      }
      if (pin && now.freeLane === lane) {
        setFreeChoice("none");
      } else {
        slide(lane);
      }
    },
    [live, writeLanes, setFreeChoice, slide],
  );
  const movePinned = useCallback(
    (from: number, to: number) => {
      const now = live.current;
      writeLanes(laneSettings(reorder(now.pinnedOrder, from, to), now.toggleOrder));
    },
    [live, writeLanes],
  );
  const moveToggle = useCallback(
    (from: number, to: number) => {
      const now = live.current;
      writeLanes(laneSettings(now.pinnedOrder, reorder(now.toggleOrder, from, to)));
    },
    [live, writeLanes],
  );
  /**
   * A row's git mark: switches to the repository or worktree and slides git out; on the active one,
   * the strip's toggle.
   */
  const showChanges = useCallback(
    (refKey: string) => {
      setActiveRefKey(refKey);
      const { pinnedLanes: pinned, freeLane: free } = live.current;
      if (refKey === activeRefKeyRef.current || (!pinned.has("git") && free !== "git")) {
        toggleLane("git");
      }
    },
    [activeRefKeyRef, setActiveRefKey, live, toggleLane],
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
    showChanges,
  };
}
