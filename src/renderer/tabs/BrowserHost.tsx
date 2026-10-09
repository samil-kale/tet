import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  BROWSER_DOCKS,
  type BrowserBounds,
  type BrowserCredentials,
  type BrowserDock,
  type BrowserEdit,
  type BrowserGo,
  type BrowserLogin,
  type BrowserMenu,
  type BrowserPart,
  type BrowserTabInfo,
} from "../../shared/types/browser";
import type { ProjectRef } from "../../shared/types/project";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { filled, followUpHeldBack, prompt } from "../ui/Dialog";
import { TextField } from "../ui/Field";
import { BackIcon, DevToolsIcon, DockIcon, ForwardIcon, ReloadIcon } from "../ui/icons";
import { IconButton } from "../ui/IconButton";
import { layoutChoice, useStoredShare } from "../ui/layout-storage";
import { MIN_AREA_HEIGHT, MIN_AREA_WIDTH, Sash } from "../ui/Sash";
import { useElementSize } from "../ui/use-element-size";
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

/** Where DevTools open, as the user last docked them: one for every tab, as Chrome's dock side. */
const devToolsDock = layoutChoice("browser.devtools-dock", BROWSER_DOCKS, "right");

/** The dock button's title for where it docks to, as Chrome's dock side menu names them. */
const DOCK_TITLES: Record<BrowserDock, string> = {
  right: "Dock to Right",
  bottom: "Dock to Bottom",
  window: "Undock into Separate Window",
};

/** The side of a view's box the sash between page and DevTools lies on. */
type SashSide = "left" | "top" | "right" | "bottom";

/** Half the sash's hit area (`.sash`, 4px, its line in the middle): what each view beside it leaves
 *  free, which it would otherwise cover, drawn above TET's page — the sash is grabbed on all of it. */
const SASH_HALF = 2;

/**
 * Where the page, or its DevTools, is drawn within its box. A pane's left border is the sash's
 * line, drawn in the pane's first pixel column (`.sash`), which the view would cover: it starts one
 * pixel in, past it. Beside the sash between page and DevTools (`sashSide`), it leaves that sash's
 * half free. Whole pixels, as main sets a view's bounds: its still, laid where these say, then lies
 * exactly where the view did.
 */
function viewBounds(box: DOMRect, sashSide?: SashSide): BrowserBounds {
  const inset = (side: SashSide): number => (side === sashSide ? SASH_HALF : 0);
  const x = Math.round(box.left > 0 ? Math.min(box.left + Math.max(1, inset("left")), box.right) : box.left);
  const y = Math.round(Math.min(box.top + inset("top"), box.bottom));
  const right = Math.round(Math.max(box.right - inset("right"), x));
  const bottom = Math.round(Math.max(box.bottom - inset("bottom"), y));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * A view's still (`browser.still`), where the view lay in its box when taken, in CSS pixels. The
 * view lies on whole CSS pixels (`viewBounds`), which at a fractional scale end inside a device
 * pixel: the view is drawn from the rounded one (133 for 132.5), its still holds every device pixel
 * the view touches (1248 for 132.5 to 1379.5). So the still is laid from that rounded device pixel,
 * one image pixel to one device pixel, its surplus cut off by the box; on the view's CSS box Blink
 * would round the other way than the view, a device pixel off.
 */
interface Still {
  url: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface BrowserViewProps {
  at: ProjectRef;
  tabId: string;
  part: BrowserPart;
  /** The box the view is drawn over. */
  box: RefObject<HTMLDivElement | null>;
  /** The docked DevTools' size, from their sash; the page takes the rest. */
  style?: React.CSSProperties;
  /** On screen in its pane, its pane on screen. */
  shown: boolean;
  /** Something of the window lies over the tab: a still of the view instead. */
  over: boolean;
  /** The side the sash between page and DevTools lies on, which it leaves free (`viewBounds`). */
  sashSide?: SashSide;
  /** Its box moved, which may move it under what floats. */
  onPlaced: () => void;
  children?: ReactNode;
}

/**
 * A view of main's (browser/browser-tabs.ts), the page or its docked DevTools, drawn above TET's
 * page, so this box only says where: on screen, it hands main its bounds, out of sight none. Under
 * something of the window (`over`), the view is hidden and a still of it shown in the box instead,
 * taken anew every STILL_INTERVAL_MS, as VS Code's browser does.
 */
function BrowserView({ at, tabId, part, box, style, shown, over, sashSide, onPlaced, children }: BrowserViewProps) {
  // Under something of the window, a still of the view, taken while it is still drawn. The view is
  // hidden only once the still is painted (`laid`), and once nothing lies over it the still stays
  // until the view is drawn again (two frames): either way round, the box would flash empty.
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
      const rect = box.current?.getBoundingClientRect();
      const url = await window.tet.browser.still(at, tabId, part);
      if (!gone && url && rect) {
        const { x, y, width, height } = viewBounds(rect, sashSide);
        const ratio = window.devicePixelRatio;
        const [left, top] = [Math.round(x * ratio) / ratio, Math.round(y * ratio) / ratio];
        const pixels = {
          width: Math.ceil((x + width) * ratio) - Math.floor(x * ratio),
          height: Math.ceil((y + height) * ratio) - Math.floor(y * ratio),
        };
        setStill({ url, left: left - rect.left, top: top - rect.top, width: pixels.width / ratio, height: pixels.height / ratio });
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
  }, [at, tabId, part, box, over, sashSide]);
  const drawn = shown && !(over && laid);

  // The view follows its box while drawn; under its still, out of sight, or gone from this pane
  // (closed, or moved to another, whose host places it anew), it is hidden.
  useEffect(() => {
    const element = box.current;
    if (!element || !drawn) {
      return;
    }
    /** The bounds last handed main: a window resize reports the box twice, mostly unmoved. */
    let placed = "";
    const place = (): void => {
      const bounds = viewBounds(element.getBoundingClientRect(), sashSide);
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === placed) {
        return;
      }
      placed = key;
      window.tet.browser.place(at, tabId, part, bounds);
      onPlaced();
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.tet.browser.place(at, tabId, part, null);
    };
  }, [at, tabId, part, box, drawn, sashSide, onPlaced]);

  return (
    <div ref={box} className={`browser-view${part === "devTools" ? " browser-devtools" : ""}`} style={style}>
      {still && (
        <img
          className="browser-still"
          src={still.url}
          alt=""
          style={{ left: still.left, top: still.top, width: still.width, height: still.height }}
          onLoad={() => requestAnimationFrame(() => setLaid(true))}
        />
      )}
      {children}
    </div>
  );
}

/**
 * A browser tab: its address bar, then the box its page is drawn over (BrowserView), its DevTools
 * docked beside or below it. Under a dialog, or where something floats over the tab
 * (window-covered.ts), both show stills instead.
 */
export const BrowserHost = memo(function BrowserHost({ at, tab, active, visible, focused, onFocused, onOpenTab }: BrowserHostProps) {
  const { tabId } = tab;
  const body = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const devToolsBox = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  /** The address bar while typed into; null shows the page's own address. As in Chrome, an edit
   *  outlives leaving the bar and goes with Escape or the page going elsewhere. */
  const [typed, setTyped] = useState<string | null>(null);
  useEffect(() => setTyped(null), [tab.url]);
  const covered = useWindowCovered();
  const shown = active && visible;
  const floating = useFloating(shown);

  /** Counts the views' box changes (`onPlaced`): a window or pane resize moves them under what floats. */
  const [moved, setMoved] = useState(0);
  const placed = useCallback(() => setMoved((count) => count + 1), []);

  // Measured where the floating elements are: each change of them, or of the views' boxes, measures
  // again. A notice over the tab holds it until dismissed, which the page says, as VS Code's does.
  const [overlapped, setOverlapped] = useState<{ any: boolean; notice: boolean }>({ any: false, notice: false });
  useEffect(() => {
    const box = body.current?.getBoundingClientRect();
    const over = shown && box !== undefined ? floating.filter((entry) => overlaps(entry.element.getBoundingClientRect(), box)) : [];
    const next = { any: over.length > 0, notice: over.some((entry) => entry.notice) };
    setOverlapped((current) => (current.any === next.any && current.notice === next.notice ? current : next));
  }, [floating, shown, moved]);

  const over = shown && (covered || overlapped.any);
  const paused = shown && !covered && overlapped.notice;

  // Where every page's DevTools open, told main once: it starts with Chrome's default.
  useEffect(() => {
    window.tet.browser.dock(devToolsDock.get());
  }, []);
  const docked = tab.devTools === "right" || tab.devTools === "bottom" ? tab.devTools : undefined;
  // Closed, the button offers what follows where they open next, disabled.
  const nextDock = BROWSER_DOCKS[(BROWSER_DOCKS.indexOf(tab.devTools ?? devToolsDock.get()) + 1) % BROWSER_DOCKS.length];
  const dock = (next: BrowserDock) => (): void => {
    devToolsDock.set(next);
    window.tet.browser.dock(next);
  };

  // One share for every tab's DevTools, beside or below, as for the Markdown preview; half until dragged.
  const [devToolsShare, setDevToolsShare] = useStoredShare("browser-devtools", 1 / 2);
  const bodySize = useElementSize(body, docked);
  const bodyExtent = (docked === "right" ? bodySize?.width : bodySize?.height) ?? 0;
  const devToolsSize = Math.round(bodyExtent * devToolsShare);
  const resizeDevTools = useCallback(
    (size: number) => {
      if (bodyExtent > 0) {
        setDevToolsShare(size / bodyExtent);
      }
    },
    [setDevToolsShare, bodyExtent],
  );

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
        const box = page.current && viewBounds(page.current.getBoundingClientRect());
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
          <IconButton
            active={tab.devTools !== undefined}
            title={`${tab.devTools ? "Close" : "Open"} DevTools (F12)`}
            onClick={() => window.tet.browser.toggleDevTools(at, tabId)}
          >
            <DevToolsIcon />
          </IconButton>
          <IconButton title={DOCK_TITLES[nextDock]} disabled={!tab.devTools} onClick={dock(nextDock)}>
            <DockIcon dock={nextDock} />
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
      <div ref={body} className={`browser-body${docked === "bottom" ? " bottom" : ""}`}>
        <BrowserView at={at} tabId={tabId} part="page" box={page} shown={shown} over={over} sashSide={docked} onPlaced={placed}>
          {paused && (
            <div className="browser-paused">
              <div className="browser-paused-message">
                <div className="browser-paused-heading">Paused due to Notification</div>
                <div className="browser-paused-detail">Dismiss the notification to continue using the browser.</div>
              </div>
            </div>
          )}
        </BrowserView>
        {docked && (
          <>
            <Sash
              orientation={docked === "right" ? "vertical" : "horizontal"}
              size={devToolsSize}
              min={docked === "right" ? MIN_AREA_WIDTH : MIN_AREA_HEIGHT}
              minOther={docked === "right" ? MIN_AREA_WIDTH : MIN_AREA_HEIGHT}
              reverse
              onResize={resizeDevTools}
            />
            <BrowserView
              at={at}
              tabId={tabId}
              part="devTools"
              box={devToolsBox}
              style={docked === "right" ? { width: devToolsSize } : { height: devToolsSize }}
              shown={shown}
              over={over}
              sashSide={docked === "right" ? "left" : "top"}
              onPlaced={placed}
            />
          </>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.menu)} onClose={() => setMenu(null)} />}
    </div>
  );
});
