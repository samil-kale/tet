import { useCallback, useState, type RefObject } from "react";
import { useLatest } from "./use-latest";
import { usePaneToggle } from "./layout-storage";
import type { SideView } from "../terminal/Pane";

/** The side pane's view, its slide, and the ways views open it. */
interface SidePane {
  sideView: SideView | null;
  sideSliding: boolean;
  stopSliding: () => void;
  toggleSideView: (view: SideView) => void;
  showChanges: (key: string) => void;
}

/**
 * Whether the side pane is out, and whether it shows files instead of git — remembered like a
 * pane size. One view at a time, as VS Code's Explorer and Source Control. `activeKeyRef` is the
 * repository or worktree in front, `setActiveKey` how a row's git mark brings its own there.
 */
export function useSidePane(
  activeKeyRef: RefObject<string | null>,
  setActiveKey: (key: string) => void
): SidePane {
  const [sidePaneOpen, setSidePaneOpen] = usePaneToggle("git-pane", false);
  const [filesShown, setFilesShown] = usePaneToggle("side-pane-files", false);
  const sideView: SideView | null = sidePaneOpen ? (filesShown ? "files" : "git") : null;
  /** Read on a click, so `toggleSideView` — and every view handed it — stays the same across a
   *  toggle. */
  const sideViewRef = useLatest(sideView);
  /**
   * Gates `.side-pane.sliding`'s width transition to the slide alone — the pane stays in the DOM
   * at width 0 while in, so opening and closing both transition — and the sash sets the same
   * width, where an animated one would lag the pointer. Set by what opens or closes the pane,
   * cleared once the transition ends; switching views while out slides nothing. Not without a
   * repository or worktree: no pane is drawn then, and nothing would end the transition.
   */
  const [sideSliding, setSideSliding] = useState(false);
  const stopSliding = useCallback(() => setSideSliding(false), []);
  const slidePane = useCallback((open: boolean) => {
    setSidePaneOpen(open);
    if (activeKeyRef.current !== null) {
      setSideSliding(true);
    }
  }, [activeKeyRef, setSidePaneOpen]);
  /** Shows that view, or slides the pane in when that view is already out. */
  const toggleSideView = useCallback(
    (view: SideView) => {
      if (sideViewRef.current === view) {
        slidePane(false);
        return;
      }
      setFilesShown(view === "files");
      if (sideViewRef.current === null) {
        slidePane(true);
      }
    },
    [setFilesShown, sideViewRef, slidePane]
  );
  /**
   * A row's git mark: switches to the repository or worktree and slides git out; on the one shown,
   * the strip's toggle.
   */
  const showChanges = useCallback(
    (key: string) => {
      setActiveKey(key);
      if (key === activeKeyRef.current) {
        toggleSideView("git");
      } else {
        setFilesShown(false);
        if (sideViewRef.current === null) {
          slidePane(true);
        }
      }
    },
    [activeKeyRef, setActiveKey, toggleSideView, setFilesShown, sideViewRef, slidePane]
  );

  return { sideView, sideSliding, stopSliding, toggleSideView, showChanges };
}
