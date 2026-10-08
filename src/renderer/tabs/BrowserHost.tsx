import { memo, useEffect, useRef, useState } from "react";
import type { BrowserBounds, BrowserTabInfo } from "../../shared/types/browser";
import type { ProjectRef } from "../../shared/types/project";
import { BackIcon, ForwardIcon, ReloadIcon } from "../ui/icons";
import { IconButton } from "../ui/IconButton";
import { useFloating, useWindowCovered } from "../ui/window-covered";

interface BrowserHostProps {
  at: ProjectRef;
  tab: BrowserTabInfo;
  /** The one on screen in its pane. */
  active: boolean;
  /** Whether the pane itself is on screen — the repository or worktree is the active one. */
  visible: boolean;
  /** In the repository's or worktree's focused pane, which gets keyboard focus. */
  focused: boolean;
  /** A click into the page, which the pane's own mousedown never sees: the pane takes the focus. */
  onPressed: () => void;
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.width > 0 && a.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The tabs whose page something of the window lies over; while there is one, TET's page is raised. */
const lainOver = new Set<string>();

/**
 * Raises TET's page above the browser tabs' pages while something of it lies over one, or lowers
 * it again (window.ts's `raise`). Raised, it must be transparent beneath every live page
 * (`browser-raised`, styles.css), so that is drawn before the raise and kept until after the lower:
 * either way round, an opaque frame would blank the page.
 */
function lieOver(tabId: string, over: boolean): void {
  const raised = lainOver.size > 0;
  if (over) {
    lainOver.add(tabId);
  } else {
    lainOver.delete(tabId);
  }
  if (raised === lainOver.size > 0) {
    return;
  }
  const root = document.documentElement;
  if (lainOver.size > 0) {
    root.classList.add("browser-raised");
    // Once that frame is drawn.
    requestAnimationFrame(() => requestAnimationFrame(() => lainOver.size > 0 && window.tet.browser.raise(true)));
  } else {
    window.tet.browser.raise(false);
    requestAnimationFrame(() => requestAnimationFrame(() => lainOver.size === 0 && root.classList.remove("browser-raised")));
  }
}

/**
 * A browser tab: its address bar, then the box its page is drawn over. The page is main's own view
 * (browser/browser-tabs.ts), drawn above TET's page, so this box only says where: on screen, it
 * hands main its bounds, out of sight none. Under a dialog, or where something floats over it
 * (window-covered.ts), TET's page is raised above it and lets it through (`lieOver`): the page stays
 * as it is, live.
 */
export const BrowserHost = memo(function BrowserHost({ at, tab, active, visible, focused, onPressed }: BrowserHostProps) {
  const { tabId } = tab;
  const page = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  /** The address bar while typed into; null shows the page's own address. */
  const [typed, setTyped] = useState<string | null>(null);
  const covered = useWindowCovered();
  const floating = useFloating();
  const shown = active && visible;

  // Measured where the floating elements are: each change of them measures again.
  const [overlapped, setOverlapped] = useState(false);
  useEffect(() => {
    const box = page.current?.getBoundingClientRect();
    setOverlapped(shown && box !== undefined && floating.some((entry) => overlaps(entry.getBoundingClientRect(), box)));
  }, [floating, shown]);

  const over = shown && (covered || overlapped);
  useEffect(() => {
    lieOver(tabId, over);
    return () => lieOver(tabId, false);
  }, [tabId, over]);

  // The page follows its box while on screen; out of sight, or gone from this pane (closed, or moved
  // to another, whose host places it anew), it is hidden.
  useEffect(() => {
    const element = page.current;
    if (!element || !shown) {
      return;
    }
    const place = (): void => {
      const { left, top, width, height } = element.getBoundingClientRect();
      const bounds: BrowserBounds = { x: left, y: top, width, height };
      window.tet.browser.place(at, tabId, bounds);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.tet.browser.place(at, tabId, null);
    };
  }, [at, tabId, shown]);

  // A click into the page focuses this pane, as one into a terminal does.
  useEffect(
    () =>
      window.tet.browser.onPressed((pressed) => {
        if (pressed.tabId === tabId) {
          onPressed();
        }
      }),
    [tabId, onPressed],
  );

  // The tab the browser verbs act on is the one last on screen.
  useEffect(() => {
    if (shown) {
      window.tet.browser.reportActive(at, tabId);
    }
  }, [at, tabId, shown]);

  // A blank page is opened to type an address into.
  const blank = tab.url === "about:blank" || tab.url === "";
  useEffect(() => {
    if (shown && focused && blank) {
      address.current?.focus();
    }
  }, [shown, focused, blank]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && typed !== null && typed.trim() !== "") {
      window.tet.browser.navigate(at, tabId, typed);
      setTyped(null);
      address.current?.blur();
    } else if (event.key === "Escape") {
      setTyped(null);
      address.current?.blur();
    }
  };

  return (
    <div className={`browser-tab${active ? "" : " hidden"}`}>
      <div className="editor-bar">
        <div className="editor-bar-actions">
          <IconButton title="Back" disabled={!tab.canGoBack} onClick={() => window.tet.browser.go(at, tabId, "back")}>
            <BackIcon />
          </IconButton>
          <IconButton title="Forward" disabled={!tab.canGoForward} onClick={() => window.tet.browser.go(at, tabId, "forward")}>
            <ForwardIcon />
          </IconButton>
          <IconButton title="Reload" onClick={() => window.tet.browser.go(at, tabId, "reload")}>
            <ReloadIcon />
          </IconButton>
        </div>
        <input
          ref={address}
          type="text"
          className="browser-address"
          aria-label="Address"
          placeholder="Address, e.g. localhost:3000"
          spellCheck={false}
          value={typed ?? (blank ? "" : tab.url)}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setTyped(null)}
        />
      </div>
      <div ref={page} className={`browser-page${shown ? " live" : ""}`} />
    </div>
  );
});
