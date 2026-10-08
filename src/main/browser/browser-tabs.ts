import * as fs from "node:fs";
import * as path from "node:path";
import { app, session, WebContentsView, type Debugger } from "electron";
import { shortcutOf, type ShortcutId } from "../../shared/shortcuts";
import {
  BROWSER_TAB_PREFIX,
  type BrowserBounds,
  type BrowserEdit,
  type BrowserMenu,
  type BrowserTabInfo,
} from "../../shared/types/browser";
import { refKeyOf, sameProjectRef, type ProjectRef } from "../../shared/types/project";
import type { NoticeSeverity } from "../../shared/types/app";
import { ownedWorktreeKeys } from "../store/project-dirs";
import { logError } from "../util/error-log";
import { PLATFORM } from "../util/host-platform";
import { isOpenableUrl } from "../util/shell-open";

/** The one window, whose content the pages are drawn into above TET's own page (window.ts). */
export interface ViewHost {
  addView(view: WebContentsView): void;
  removeView(view: WebContentsView): void;
  /** TET's page above the pages, for what of it lies over one; or back beneath them. */
  raise(raised: boolean): void;
}

export interface BrowserTabsDeps {
  host: ViewHost;
  /** The repository's or worktree's tabs changed: their list, title, address or loading. */
  onTabs(ref: ProjectRef, tabs: BrowserTabInfo[]): void;
  /** A tab the page opened itself (a popup, a link to a new window), to bring to the front. */
  onOpened(ref: ProjectRef, tabId: string): void;
  /** A click into a page, which the window never sees: its pane takes the focus. */
  onPressed(ref: ProjectRef, tabId: string): void;
  /** A tab closed: what drives its page lets go (browser-automation's). */
  onClosed(tabId: string): void;
  /** A window shortcut pressed on a page, which the window never sees. */
  onShortcut(shortcut: ShortcutId): void;
  /** A right click into a page, whose menu the window draws. */
  onMenu(ref: ProjectRef, tabId: string, menu: BrowserMenu): void;
  notice(severity: NoticeSeverity, message: string): void;
}

/** A page as the CDP proxy reaches it (cdp-proxy.ts). */
export interface BrowserPage {
  tabId: string;
  /** Chromium's own id of the page, as CDP names its target. */
  targetId: string;
  url: string;
  title: string;
  debugger: Debugger;
}

interface Tab {
  tabId: string;
  ref: ProjectRef;
  view: WebContentsView;
}

/**
 * What a page gets without asking, as Chrome grants it itself; every other permission (camera,
 * microphone, location, notifications, reading the clipboard) is refused, which Electron would
 * otherwise grant unasked. The local network ones answer `permissions.query` as Electron already
 * behaves: it never checks local network access, and sites that ask first break on a denial.
 */
const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  "pointerLock",
  "keyboardLock",
  "fullscreen",
  "clipboard-sanitized-write",
  "local-network-access",
  "local-network",
  "loopback-network",
]);

/** Chromium's code for a load a newer one replaced: no failure. */
const ERR_ABORTED = -3;

/** How long `load` waits for a page; one still loading then is no failure, the agent reads it on. */
const LOAD_WAIT_MS = 30_000;

/** A worktree's profile folder, as Chromium spells `partitionOf`'s name on disk: in lower case. */
const WORKTREE_PROFILE = /^tet-([0-9a-f-]{36})-([0-9a-f]+)$/;

/** A host the machine itself serves, reached over http as a dev server is. */
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i;

/**
 * An address as typed into the address bar or handed to `tet-ctl browser-open`: http and https as
 * given, `about:blank`; without a scheme, http for a local host, else https. Any other scheme
 * (file, javascript, chrome) is refused: a tab shows the web, not this machine.
 */
export function browserUrl(typed: string): string {
  const url = typed.trim();
  if (url === "" || url === "about:blank") {
    return "about:blank";
  }
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  // A scheme, not a host's port (`localhost:3000`).
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url)) {
    throw new Error("not a web address");
  }
  return `${LOCAL_HOST.test(url) ? "http" : "https"}://${url}`;
}

/**
 * Every repository's and worktree's browser tabs, each page a `WebContentsView` drawn into the
 * window where its tab's box lies (`place`). A worktree's tabs share a profile of its own, deleted
 * with it (`clearProfile`); the repository's share the global one. Chromium keeps both in its own
 * `userData` (data-root.ts), so logins outlive a restart. Never persisted: a restart opens none,
 * and the tabs close with the window.
 */
export class BrowserTabs {
  /** By tab id, unique across every repository and worktree; in the order opened. */
  private readonly tabs = new Map<string, Tab>();
  /** Per `refKey`: the tab the browser verbs act on without `--tab`, as the window reports it. */
  private readonly active = new Map<string, string>();
  /** The partitions whose permissions are answered (`GRANTED_PERMISSIONS`). */
  private readonly guarded = new Set<string>();
  private created = 0;

  constructor(private readonly deps: BrowserTabsDeps) {}

  list(ref: ProjectRef): BrowserTabInfo[] {
    return this.of(ref).map(infoOf);
  }

  /** `tabId` of the repository or worktree, else its active tab, else its last opened. */
  page(ref: ProjectRef, tabId?: string): BrowserPage | undefined {
    const tab = tabId === undefined ? (this.find(ref, this.active.get(refKeyOf(ref))) ?? this.of(ref).at(-1)) : this.find(ref, tabId);
    return tab && pageOf(tab);
  }

  /** Any repository's or worktree's. */
  pageById(tabId: string): BrowserPage | undefined {
    const tab = this.tabs.get(tabId);
    return tab && pageOf(tab);
  }

  /** A new tab loading `typed` (browserUrl), made the active one; `loaded` settles as `load` does. */
  create(ref: ProjectRef, typed: string): { tab: BrowserTabInfo; loaded: Promise<void> } {
    const url = browserUrl(typed);
    const view = new WebContentsView({
      webPreferences: { session: this.profileOf(ref), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    const tab: Tab = { tabId: `${BROWSER_TAB_PREFIX}${++this.created}`, ref, view };
    const changed = (): void => this.changed(ref);
    view.setVisible(false);
    view.webContents.on("did-start-loading", changed);
    view.webContents.on("did-stop-loading", changed);
    view.webContents.on("page-title-updated", changed);
    view.webContents.on("did-navigate", changed);
    view.webContents.on("did-navigate-in-page", changed);
    view.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) {
        this.deps.notice("warning", `Could not load ${failedUrl}: ${description}`);
      }
    });
    // A popup or a link to a new window opens as a tab of the same repository or worktree, in its
    // profile; the opener does not reach it.
    view.webContents.setWindowOpenHandler(({ url: opened }) => {
      try {
        const popup = this.create(ref, opened);
        popup.loaded.catch(() => undefined);
        this.deps.onOpened(ref, popup.tab.tabId);
      } catch {
        // Not a web address: nothing opens.
      }
      return { action: "deny" };
    });
    // A dev server's own certificate is taken on a local host, as Chrome's allow-insecure-localhost
    // takes it; anywhere else Chromium's refusal stands.
    view.webContents.on("certificate-error", (event, failedUrl, _error, _certificate, callback) => {
      const local = LOCAL_HOST.test(new URL(failedUrl).host);
      if (local) {
        event.preventDefault();
      }
      callback(local);
    });
    view.webContents.on("context-menu", (_event, params) =>
      this.deps.onMenu(ref, tab.tabId, {
        x: params.x,
        y: params.y,
        linkUrl: params.linkURL,
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      }),
    );
    view.webContents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown") {
        this.deps.onPressed(ref, tab.tabId);
      }
    });
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") {
        return;
      }
      // The page's own DevTools, as F12 opens TET's for the window (window.ts).
      if (input.key === "F12") {
        event.preventDefault();
        if (view.webContents.isDevToolsOpened()) {
          view.webContents.closeDevTools();
        } else {
          openDevTools(view);
        }
        return;
      }
      const shortcut = shortcutOf(
        { key: input.key, code: input.code, shiftKey: input.shift, altKey: input.alt, ctrlKey: input.control, metaKey: input.meta },
        PLATFORM,
      );
      if (shortcut) {
        event.preventDefault();
        this.deps.onShortcut(shortcut);
      }
    });
    this.deps.host.addView(view);
    this.tabs.set(tab.tabId, tab);
    this.active.set(refKeyOf(ref), tab.tabId);
    const loaded = load(tab, url);
    this.changed(ref);
    return { tab: infoOf(tab), loaded };
  }

  /** Loads `typed` (browserUrl) in the tab; rejects with Chromium's reason when it cannot. */
  async navigate(ref: ProjectRef, tabId: string, typed: string): Promise<void> {
    const tab = this.find(ref, tabId);
    if (!tab) {
      throw new Error(`no browser tab ${tabId}`);
    }
    await load(tab, browserUrl(typed));
  }

  go(ref: ProjectRef, tabId: string, where: "back" | "forward" | "reload"): void {
    const view = this.find(ref, tabId)?.view;
    if (where === "back") {
      view?.webContents.navigationHistory.goBack();
    } else if (where === "forward") {
      view?.webContents.navigationHistory.goForward();
    } else {
      view?.webContents.reload();
    }
  }

  /** The menu's edit command; the page then has the focus again, which the menu took. */
  edit(ref: ProjectRef, tabId: string, edit: BrowserEdit): void {
    const view = this.find(ref, tabId)?.view;
    if (view) {
      view.webContents[edit]();
      view.webContents.focus();
    }
  }

  /** The page's DevTools, as F12 opens them, on the element at `x`, `y`. */
  inspect(ref: ProjectRef, tabId: string, x: number, y: number): void {
    const view = this.find(ref, tabId)?.view;
    if (view) {
      openDevTools(view);
      view.webContents.inspectElement(x, y);
    }
  }

  close(ref: ProjectRef, tabId: string): void {
    const tab = this.find(ref, tabId);
    if (tab) {
      this.dispose(tab);
      this.changed(ref);
    }
  }

  /** The window closed: every tab goes with it, their pages drawn nowhere else. */
  closeEverything(): void {
    [...this.tabs.values()].forEach((tab) => this.dispose(tab));
    this.active.clear();
  }

  /** The repository or worktree closed: every tab of it goes. */
  closeAll(ref: ProjectRef): void {
    this.of(ref).forEach((tab) => this.dispose(tab));
    this.active.delete(refKeyOf(ref));
  }

  /** Draws the page over `bounds`, or hides it. */
  place(ref: ProjectRef, tabId: string, bounds: BrowserBounds | null): void {
    const view = this.find(ref, tabId)?.view;
    if (!view) {
      return;
    }
    if (bounds) {
      view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    }
    view.setVisible(bounds !== null);
  }

  /** The page as it looks, a PNG, for `browser-screenshot`; drawn or not, out of sight too. Null
   *  when it has no look yet. */
  async capture(ref: ProjectRef, tabId: string): Promise<Buffer | null> {
    const image = await this.find(ref, tabId)?.view.webContents.capturePage();
    return image && !image.isEmpty() ? image.toPNG() : null;
  }

  /** TET's page above every tab's page, which it lets through where it is transparent; or back. */
  raise(raised: boolean): void {
    this.deps.host.raise(raised);
  }

  setActive(ref: ProjectRef, tabId: string): void {
    this.active.set(refKeyOf(ref), tabId);
  }

  /** A deleted worktree's logins, cookies and cache; the global profile is never cleared. A failure
   *  is logged: the worktree is gone either way. */
  async clearProfile(ref: ProjectRef): Promise<void> {
    if (ref.worktree === undefined) {
      return;
    }
    const profile = session.fromPartition(partitionOf(ref));
    await Promise.all([profile.clearStorageData(), profile.clearCache()]).catch((error: unknown) =>
      logError(`could not clear the browser profile of ${refKeyOf(ref)}`, error),
    );
  }

  /** The repository's or worktree's profile, its permissions answered from its first tab on. */
  private profileOf(ref: ProjectRef): Electron.Session {
    const partition = partitionOf(ref);
    const profile = session.fromPartition(partition);
    if (!this.guarded.has(partition)) {
      this.guarded.add(partition);
      // A link to mail leaves for the mail app, as one in TET's own page does (window.ts).
      profile.setPermissionRequestHandler((_contents, permission, callback, details) =>
        callback(
          GRANTED_PERMISSIONS.has(permission) ||
            (permission === "openExternal" && "externalURL" in details && isOpenableUrl(details.externalURL ?? "")),
        ),
      );
      profile.setPermissionCheckHandler((_contents, permission) => GRANTED_PERMISSIONS.has(permission));
    }
    return profile;
  }

  private of(ref: ProjectRef): Tab[] {
    return [...this.tabs.values()].filter((tab) => sameProjectRef(tab.ref, ref));
  }

  private find(ref: ProjectRef, tabId: string | undefined): Tab | undefined {
    const tab = tabId === undefined ? undefined : this.tabs.get(tabId);
    return tab && sameProjectRef(tab.ref, ref) ? tab : undefined;
  }

  private dispose(tab: Tab): void {
    this.tabs.delete(tab.tabId);
    this.deps.onClosed(tab.tabId);
    this.deps.host.removeView(tab.view);
    tab.view.webContents.close();
  }

  private changed(ref: ProjectRef): void {
    this.deps.onTabs(ref, this.list(ref));
  }
}

/** Settles once the page has loaded, or after LOAD_WAIT_MS while it still loads; rejects with
 *  Chromium's reason for a page that cannot load. */
function load(tab: Tab, url: string): Promise<void> {
  const loaded = tab.view.webContents.loadURL(url).catch((error: unknown) => {
    if ((error as { errno?: number }).errno !== ERR_ABORTED) {
      throw error;
    }
    // Replaced by a navigation of the page's own (a redirect in script): loaded once that one is.
    return tab.view.webContents.isLoading()
      ? new Promise<void>((resolve) => tab.view.webContents.once("did-stop-loading", () => resolve()))
      : undefined;
  });
  return Promise.race([loaded, new Promise<void>((resolve) => setTimeout(resolve, LOAD_WAIT_MS).unref())]);
}

/** Detached, as F12 opens TET's own for the window (window.ts). */
function openDevTools(view: WebContentsView): void {
  if (!view.webContents.isDevToolsOpened()) {
    view.webContents.openDevTools({ mode: "detach" });
  }
}

/**
 * Deletes the profiles of the worktrees gone, at startup before any tab opens: `clearProfile`
 * empties one whose session stays loaded until TET quits, and Electron cannot unload a session.
 */
export function sweepBrowserProfiles(dataRoot: string): void {
  void (async () => {
    const root = path.join(app.getPath("sessionData"), "Partitions");
    const names = await fs.promises.readdir(root).catch((): string[] => []);
    await Promise.all(
      names.map(async (name) => {
        const match = WORKTREE_PROFILE.exec(name);
        if (!match || ownedWorktreeKeys(dataRoot, match[1]).includes(match[2])) {
          return;
        }
        await fs.promises
          .rm(path.join(root, name), { recursive: true, force: true })
          .catch((error: unknown) => logError(`could not delete the browser profile ${name}`, error));
      }),
    );
  })();
}

/** A worktree's own profile, or the global one of every repository. */
function partitionOf(ref: ProjectRef): string {
  return ref.worktree === undefined ? "persist:tet-global" : `persist:tet-${ref.projectId}-${ref.worktree}`;
}

function pageOf(tab: Tab): BrowserPage {
  return {
    tabId: tab.tabId,
    targetId: tab.view.webContents.getOrCreateDevToolsTargetId(),
    url: tab.view.webContents.getURL(),
    title: tab.view.webContents.getTitle(),
    debugger: tab.view.webContents.debugger,
  };
}

function infoOf(tab: Tab): BrowserTabInfo {
  const history = tab.view.webContents.navigationHistory;
  return {
    tabId: tab.tabId,
    url: tab.view.webContents.getURL(),
    title: tab.view.webContents.getTitle(),
    loading: tab.view.webContents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}
