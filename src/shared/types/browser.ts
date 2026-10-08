/**
 * A browser tab of a repository or worktree, as main holds it: its page lives in a `WebContentsView`
 * of the main process (src/main/browser/), which only main can make, so the window draws this
 * mirror and the tab strip lists it beside the terminals.
 */
export interface BrowserTabInfo {
  /** Unique within its repository or worktree; never a session id, so the layout never keeps it. */
  tabId: string;
  url: string;
  /** The page's title, "" until it has one. */
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Every browser tab's id starts so, shaped unlike a session id or an editor tab's (`tet:editor:`). */
export const BROWSER_TAB_PREFIX = "tet:browser:";

export function isBrowserTabId(tabId: string): boolean {
  return tabId.startsWith(BROWSER_TAB_PREFIX);
}

/** What a right click into a page offers, as Chromium reports it; the window draws the menu. */
export interface BrowserMenu {
  /** Where the click was, in the page's CSS pixels from its top left. */
  x: number;
  y: number;
  /** The link clicked on, "" for none. */
  linkUrl: string;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
}

/** A page's server, or the proxy before it, asking for a login (HTTP authentication). */
export interface BrowserLogin {
  /** Names the request its answer goes back to. */
  id: number;
  host: string;
  /** The server's name for what it protects, "" for none. */
  realm: string;
  proxy: boolean;
}

export interface BrowserCredentials {
  username: string;
  password: string;
}

/** The page's own edit commands, on what has its focus or selection. */
export type BrowserEdit = "cut" | "copy" | "paste" | "selectAll";

/** Where the page is drawn, in the window's CSS pixels. */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
