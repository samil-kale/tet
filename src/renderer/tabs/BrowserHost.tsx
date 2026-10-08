import { memo, useEffect, useRef, useState } from "react";
import type { BrowserBounds, BrowserCredentials, BrowserLogin, BrowserTabInfo } from "../../shared/types/browser";
import type { ProjectRef } from "../../shared/types/project";
import { filled, followUpHeldBack, prompt } from "../ui/Dialog";
import { TextField } from "../ui/Field";
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
  /** The page took the focus (a click into it), which the pane's own mousedown never sees: the
   *  pane takes it too. */
  onFocused: () => void;
  /** A link of the page opened from its menu, as a new tab in this pane. */
  onOpenTab: (url: string) => void;
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.width > 0 && a.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * A page's login, as a browser's own sign-in box asks for it; cancelled, the page shows its
 * refusal. Main puts the question, which no other request of main's does: the page asked, not the
 * user. Held back by another question, it is cancelled and said.
 */
async function askLogin(login: BrowserLogin): Promise<void> {
  const what = `${login.proxy ? "The proxy " : ""}${login.host}`;
  if (followUpHeldBack(`${what} wanted a login while another question was open: reload the page to sign in.`)) {
    window.tet.browser.answerLogin(login.id, null);
    return;
  }
  const answered = await prompt<BrowserCredentials>({
    title: "Sign in",
    detail: `${what} asks for a login${login.realm ? `: ${login.realm}` : "."}`,
    value: { username: "", password: "" },
    confirmLabel: "Sign in",
    ready: (value) => filled(value.username),
    render: ({ value, onChange, field }) => (
      <>
        <TextField label="Username" value={value.username} onChange={(username) => onChange({ ...value, username })} ref={field} />
        <TextField label="Password" type="password" value={value.password} onChange={(password) => onChange({ ...value, password })} />
      </>
    ),
  });
  window.tet.browser.answerLogin(login.id, answered && { username: answered.username.trim(), password: answered.password });
}

/** How often the still of a page under something of the window is taken anew, as VS Code's. */
const STILL_INTERVAL_MS = 1000;

/**
 * Where the page is drawn within its box. A pane's left border is the sash's line, drawn in the
 * pane's first pixel column (`.sash`), which the page, drawn above TET's page, would cover: it
 * starts one pixel in, past it.
 */
function pageBounds({ left, top, width, height }: DOMRect): BrowserBounds {
  const inset = left > 0 ? Math.min(1, width) : 0;
  return { x: left + inset, y: top, width: width - inset, height };
}

/** A page's still (`browser.still`), where it lay in its box when taken: in from its left edge
 *  as the page is (`pageBounds`), at the page's size then. */
interface Still {
  url: string;
  left: number;
  width: number;
  height: number;
}

/**
 * A browser tab: its address bar, then the box its page is drawn over. The page is main's own view
 * (browser/browser-tabs.ts), drawn above TET's page, so this box only says where: on screen, it
 * hands main its bounds, out of sight none. Under a dialog, or where something floats over it
 * (window-covered.ts), the page is hidden and a still of it shown in the box instead, taken anew
 * every STILL_INTERVAL_MS, as VS Code's browser does.
 */
export const BrowserHost = memo(function BrowserHost({ at, tab, active, visible, focused, onFocused, onOpenTab }: BrowserHostProps) {
  const { tabId } = tab;
  const page = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  /** The address bar while typed into; null shows the page's own address. */
  const [typed, setTyped] = useState<string | null>(null);
  const covered = useWindowCovered();
  const shown = active && visible;
  const floating = useFloating(shown);

  /** Counts the page's box changes (`place`): a window or pane resize moves it under what floats. */
  const [moved, setMoved] = useState(0);

  // Measured where the floating elements are: each change of them, or of the page's box, measures
  // again. A notice over the page holds it until dismissed, which the page says, as VS Code's does.
  const [overlapped, setOverlapped] = useState<{ any: boolean; notice: boolean }>({ any: false, notice: false });
  useEffect(() => {
    const box = page.current?.getBoundingClientRect();
    const over = shown && box !== undefined ? floating.filter((entry) => overlaps(entry.element.getBoundingClientRect(), box)) : [];
    const next = { any: over.length > 0, notice: over.some((entry) => entry.notice) };
    setOverlapped((current) => (current.any === next.any && current.notice === next.notice ? current : next));
  }, [floating, shown, moved]);

  const over = shown && (covered || overlapped.any);
  const paused = shown && !covered && overlapped.notice;

  // Under something of the window, a still of the page, taken while it is still drawn; once gone,
  // the still stays until the page is drawn again (two frames), or the box would show empty.
  const [still, setStill] = useState<Still | null>(null);
  useEffect(() => {
    if (!over) {
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setStill(null)));
      return () => cancelAnimationFrame(frame);
    }
    let gone = false;
    const take = async (): Promise<void> => {
      const box = page.current?.getBoundingClientRect();
      const url = await window.tet.browser.still(at, tabId);
      if (!gone && url && box) {
        const { x, width, height } = pageBounds(box);
        setStill({ url, left: x - box.left, width, height });
      }
    };
    void take();
    const timer = setInterval(() => void take(), STILL_INTERVAL_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [at, tabId, over]);
  const drawn = shown && !(over && still);

  // The page follows its box while drawn; under its still, out of sight, or gone from this pane
  // (closed, or moved to another, whose host places it anew), it is hidden.
  useEffect(() => {
    const element = page.current;
    if (!element || !drawn) {
      return;
    }
    /** The bounds last handed main: a window resize reports the box twice, mostly unmoved. */
    let placed = "";
    const place = (): void => {
      const bounds = pageBounds(element.getBoundingClientRect());
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === placed) {
        return;
      }
      placed = key;
      window.tet.browser.place(at, tabId, bounds);
      setMoved((count) => count + 1);
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
  }, [at, tabId, drawn]);

  // The page taking the focus focuses this pane, as a click into a terminal does.
  useEffect(
    () =>
      window.tet.browser.onFocused((focusedPage) => {
        if (focusedPage.tabId === tabId) {
          onFocused();
        }
      }),
    [tabId, onFocused],
  );

  // "Open Link in New Tab" from the page's own menu (browser-tabs.ts's menuOf).
  useEffect(
    () =>
      window.tet.browser.onOpenLink((opened) => {
        if (opened.tabId === tabId) {
          onOpenTab(opened.url);
        }
      }),
    [tabId, onOpenTab],
  );

  useEffect(
    () =>
      window.tet.browser.onLogin((asked) => {
        if (asked.tabId === tabId) {
          void askLogin(asked.login);
        }
      }),
    [tabId],
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
      <div ref={page} className="browser-page">
        {still && (
          <img className="browser-still" src={still.url} alt="" style={{ left: still.left, width: still.width, height: still.height }} />
        )}
        {paused && (
          <div className="browser-paused">
            <div className="browser-paused-message">
              <div className="browser-paused-heading">Paused due to Notification</div>
              <div className="browser-paused-detail">Dismiss the notification to continue using the browser.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
