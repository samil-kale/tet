import { useCallback, useState, type RefObject } from "react";
import { LANES, type Lane } from "../../shared/types/settings";
import { useLatest } from "../ui/use-latest";
import { useStoredChoice, useStoredSize } from "../ui/layout-storage";
import { MIN_AREA_WIDTH } from "../ui/Sash";

/** The lane shown, or none while it is closed. */
const CHOICES: readonly (Lane | "none")[] = [...LANES, "none"];

/** The one lane shown, in a fixed order, and the ways it opens, closes and swaps. */
interface Lanes {
  /** The lane shown, or none. */
  shownLane: Lane | null;
  width: number;
  setWidth: (size: number) => void;
  /** The lane whose width transitions now (`.lane.sliding`): opening from closed or closing to
   *  closed: never on a swap between two different lanes, which takes neither transition. */
  slidingLanes: ReadonlySet<Lane>;
  stopSliding: (lane: Lane) => void;
  /** Opens that lane from closed, closes it back if it is already shown, or swaps it in for the
   *  one shown — without either's slide. */
  toggleLane: (lane: Lane) => void;
  showChanges: (refKey: string) => void;
}

/**
 * Which lane is shown and its width are the window's layout storage, as `activeRefKeyRef` is the
 * active repository or worktree, `setActiveRefKey` how a row's git mark makes its own active.
 */
export function useLanes(activeRefKeyRef: RefObject<string | null>, setActiveRefKey: (refKey: string) => void): Lanes {
  const [choice, setChoice] = useStoredChoice("lanes-shown", CHOICES, "projects");
  const shownLane = choice === "none" ? null : choice;
  const [width, setWidth] = useStoredSize("lane-width", 300, MIN_AREA_WIDTH);
  /** Read on a click, so the callbacks stay the same across one. */
  const live = useLatest({ shownLane });

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

  const toggleLane = useCallback(
    (lane: Lane) => {
      const { shownLane: shown } = live.current;
      setChoice(shown === lane ? "none" : lane);
      // Opening from closed, or closing the one shown: slide. Swapping to a different lane: no
      // transition, as the strip's toggles have always swapped.
      if (shown === null || shown === lane) {
        setSlidingLanes((current) => new Set([...current, lane]));
      }
    },
    [live, setChoice],
  );

  /** A row's git mark: switches to the repository or worktree and shows git; on the active one,
   *  the strip's toggle. */
  const showChanges = useCallback(
    (refKey: string) => {
      setActiveRefKey(refKey);
      if (refKey === activeRefKeyRef.current || live.current.shownLane !== "git") {
        toggleLane("git");
      }
    },
    [activeRefKeyRef, setActiveRefKey, live, toggleLane],
  );

  return { shownLane, width, setWidth, slidingLanes, stopSliding, toggleLane, showChanges };
}
