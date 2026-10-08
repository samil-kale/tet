import { memo, useEffect, useRef, useState } from "react";
import type {
  BrowserBounds,
  BrowserCredentials,
  BrowserEdit,
  BrowserGo,
  BrowserLogin,
  BrowserMenu,
  BrowserTabInfo,
} from "../../shared/types/browser";
import type { ProjectRef } from "../../shared/types/project";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
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
 * starts one pixel in, past it. Whole pixels, as main sets a view's bounds: its still, laid where
 * these say, then lies exactly where the page did.
 */
function pageBounds({ left, top, right, bottom }: DOMRect): BrowserBounds {
  const x = Math.round(left > 0 ? Math.min(left + 1, right) : left);
  const y = Math.round(top);
  return { x, y, width: Math.round(right) - x, height: Math.round(bottom) - y };
}

/**
 * A page's still (`browser.still`), where the page lay in its box when taken, in CSS pixels. The
 * page lies on whole CSS pixels (`pageBounds`), which at a fractional scale end inside a device
 * pixel: the view is drawn from the rounded one (133 for 132.5), its still holds every device pixel
 * the page touches (1248 for 132.5 to 1379.5). So the still is laid from that rounded device pixel,
 * one image pixel to one device pixel, its surplus cut off by the box; on the page's CSS box Blink
 * would round the other way than the view, a device pixel off.
 */
interface Still {
  url: string;
  left: number;
  top: number;
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
  /** The address bar while typed into; null shows the page's own address. As in Chrome, an edit
   *  outlives leaving the bar and goes with Escape or the page going elsewhere. */
  const [typed, setTyped] = useState<string | null>(null);
  useEffect(() => setTyped(null), [tab.url]);
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

  // Under something of the window, a still of the page, taken while it is still drawn. The page is
  // hidden only once the still is painted (`laid`), and once nothing lies over it the still stays
  // until the page is drawn again (two frames): either way round, the box would flash empty.
  const [still, setStill] = useState<Still | null>(null);
  const [laid, setLaid] = useState(false);
  useEffect(() => {
    if (!over) {
      const frame = requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setStill(null);
          setLaid(false);
        }),
      );
      return () => cancelAnimationFrame(frame);
    }
    let gone = false;
    const take = async (): Promise<void> => {
      const box = page.current?.getBoundingClientRect();
      const url = await window.tet.browser.still(at, tabId);
      if (!gone && url && box) {
        const { x, y, width, height } = pageBounds(box);
        const ratio = window.devicePixelRatio;
        const [left, top] = [Math.round(x * ratio) / ratio, Math.round(y * ratio) / ratio];
        const pixels = {
          width: Math.ceil((x + width) * ratio) - Math.floor(x * ratio),
          height: Math.ceil((y + height) * ratio) - Math.floor(y * ratio),
        };
        setStill({ url, left: left - box.left, top: top - box.top, width: pixels.width / ratio, height: pixels.height / ratio });
      }
    };
    // One not taken (no frame there yet) leaves the last still standing.
    const takeOrNot = (): void => void take().catch(() => undefined);
    takeOrNot();
    const timer = setInterval(takeOrNot, STILL_INTERVAL_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [at, tabId, over]);
  const drawn = shown && !(over && laid);

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

  // A right click into the page: its menu, at the click, drawn by the window over the page's still.
  const [menu, setMenu] = useState<{ x: number; y: number; menu: BrowserMenu } | null>(null);
  useEffect(
    () =>
      window.tet.browser.onMenu((opened) => {
        const box = page.current && pageBounds(page.current.getBoundingClientRect());
        if (opened.tabId === tabId && box) {
          setMenu({ x: box.x + opened.menu.x, y: box.y + opened.menu.y, menu: opened.menu });
        }
      }),
    [tabId],
  );

  /** The address bar's buttons and the menu's entries alike. */
  const go = (where: BrowserGo) => () => window.tet.browser.go(at, tabId, where);

  /** Chrome's entries for a page; one that cannot go is disabled. */
  const menuEntries = (opened: BrowserMenu): ContextMenuEntry[] => {
    const edit = (command: BrowserEdit) => () => window.tet.browser.edit(at, tabId, command);
    const link: ContextMenuEntry[] = opened.linkUrl
      ? [
          { label: "Open Link in New Tab", run: () => onOpenTab(opened.linkUrl) },
          { label: "Copy Link Address", run: () => void navigator.clipboard.writeText(opened.linkUrl) },
          SEPARATOR,
        ]
      : [];
    return [
      ...link,
      { label: "Back", run: tab.canGoBack ? go("back") : undefined },
      { label: "Forward", run: tab.canGoForward ? go("forward") : undefined },
      { label: "Reload", run: go("reload") },
      SEPARATOR,
      { label: "Cut", run: opened.canCut ? edit("cut") : undefined },
      { label: "Copy", run: opened.canCopy ? edit("copy") : undefined },
      { label: "Paste", run: opened.canPaste ? edit("paste") : undefined },
      { label: "Select All", run: opened.canSelectAll ? edit("selectAll") : undefined },
      SEPARATOR,
      { label: "Inspect", run: () => window.tet.browser.inspect(at, tabId, opened.x, opened.y) },
    ];
  };

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

  // A right click as in a terminal (terminal-views.ts): copies a selection, else pastes at the
  // caret, on one line as a paste into the field would.
  const onContextMenu = (event: React.MouseEvent<HTMLInputElement>): void => {
    event.preventDefault();
    const input = event.currentTarget;
    const { selectionStart: start, selectionEnd: end } = input;
    if (start !== null && end !== null && start !== end) {
      void navigator.clipboard.writeText(input.value.slice(start, end));
      return;
    }
    input.focus();
    void navigator.clipboard.readText().then((text) => {
      const caret = input.selectionStart ?? input.value.length;
      input.setRangeText(text.replace(/\r?\n/g, ""), caret, caret, "end");
      setTyped(input.value);
    });
  };

  return (
    <div className={`browser-tab${active ? "" : " hidden"}`}>
      <div className="editor-bar">
        <div className="editor-bar-actions">
          <IconButton title="Back" disabled={!tab.canGoBack} onClick={go("back")}>
            <BackIcon />
          </IconButton>
          <IconButton title="Forward" disabled={!tab.canGoForward} onClick={go("forward")}>
            <ForwardIcon />
          </IconButton>
          <IconButton title="Reload" onClick={go("reload")}>
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
          onContextMenu={onContextMenu}
        />
      </div>
      <div ref={page} className="browser-page">
        {still && (
          <img
            className="browser-still"
            src={still.url}
            alt=""
            style={{ left: still.left, top: still.top, width: still.width, height: still.height }}
            onLoad={() => requestAnimationFrame(() => setLaid(true))}
          />
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
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.menu)} onClose={() => setMenu(null)} />}
    </div>
  );
});
