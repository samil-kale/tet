import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { app, session, WebContentsView, type Debugger } from "electron";
import { errorMessage } from "../../shared/errors";
import { isLoopbackHost } from "../../shared/loopback";
import { shortcutOf, type ShortcutId, type ShortcutKey } from "../../shared/shortcuts";
import {
  BROWSER_TAB_PREFIX,
  type BrowserBounds,
  type BrowserCredentials,
  type BrowserEdit,
  type BrowserGo,
  type BrowserLogin,
  type BrowserMenu,
  type BrowserTabInfo,
} from "../../shared/types/browser";
import { refKeyOf, sameProjectRef, type ProjectRef } from "../../shared/types/project";
import type { AgentId } from "../../shared/types/agents";
import type { NoticeSeverity } from "../../shared/types/app";
import { downloadsDir, ownedWorktreeKeys, sandboxDir } from "../store/project-dirs";
import { logError } from "../util/error-log";
import { PLATFORM } from "../util/host-platform";
import { openInside } from "../util/path-inside";
import { isOpenableUrl } from "../util/shell-open";

/** The one window, whose content the pages are drawn into above TET's own page (window.ts). */
export interface ViewHost {
  addView(view: WebContentsView): void;
  removeView(view: WebContentsView): void;
}

export interface BrowserTabsDeps {
  host: ViewHost;
  /** `~/.tet`, under which each project's downloads lie (downloadsDir). */
  dataRoot: string;
  /** The repository's or worktree's tabs changed: their list, title, address or loading. */
  onTabs(ref: ProjectRef, tabs: BrowserTabInfo[]): void;
  /** A tab the page opened itself (a popup, a link to a new window), to bring to the front. */
  onOpened(ref: ProjectRef, tabId: string): void;
  /** A page took the focus (a click into it), which the window never sees: its pane takes it too. */
  onFocused(ref: ProjectRef, tabId: string): void;
  /** A tab closed: what drives its page lets go (browser-automation's). */
  onClosed(tabId: string): void;
  /** A window shortcut pressed on a page and left alone by it (`pageKey`), which the window never sees. */
  onShortcut(shortcut: ShortcutId): void;
  /** A right click into a page, whose menu the window draws. */
  onMenu(ref: ProjectRef, tabId: string, menu: BrowserMenu): void;
  /** A page asking for a login, which its tab asks the user for (`answerLogin`). */
  onLogin(ref: ProjectRef, tabId: string, login: BrowserLogin): void;
  /** The way a sandbox's tabs reach the network (SandboxRoute); rejects when the sandbox cannot be
   *  reached, and its tabs then load nothing. */
  route(sandbox: BrowserSandbox): Promise<SandboxRoute>;
  notice(severity: NoticeSeverity, message: string): void;
}

/**
 * The sbx sandbox a tab belongs to, opened by an agent running there (`tet-ctl browser-open`): its
 * pages load through it (sandbox-proxy.ts), in a profile of its own, and what they download lands
 * in its agent folder, which it sees.
 */
export interface BrowserSandbox {
  /** sbx's name of it (sbx.ts's sandboxName). */
  name: string;
  agentId: AgentId;
  /** Its agent folder (project-dirs.ts's sandboxDir), which a download handed over must not lead
   *  out of. */
  agentDir: string;
  /** Where its pages' downloads land, inside `agentDir` (sandboxDownloadsDir). */
  downloadsDir: string;
}

/** A sandbox's way out: the proxy its profile loads through, and its proxy's certificate. */
export interface SandboxRoute {
  /** The port of the proxy on this machine's loopback. */
  port: number;
  /** The certificate the sandbox's proxy signs every HTTPS site with, PEM; none where it
   *  intercepts none. */
  ca?: string;
  /** Why a host was last refused, for the page's failure. */
  refusal(host: string): string | undefined;
  close(): void;
}

/** Whose tabs a browser verb sees: this machine's (no sandbox), or one sandbox's, by its name. */
export interface BrowserScope {
  sandbox?: string;
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

/** A file a page downloaded during this run, for `browser-downloads`. */
export interface BrowserDownload {
  ref: ProjectRef;
  /** The sandbox's name whose tab downloaded it; none for this machine's. */
  sandbox?: string;
  /** Where it is saved: the project's downloads folder, or its sandbox's (BrowserSandbox.downloadsDir). */
  path: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  /** 0 when the server did not say. */
  totalBytes: number;
}

interface Tab {
  tabId: string;
  ref: ProjectRef;
  view: WebContentsView;
  /** Opened by a page (MAX_POPUPS), not by the user or an agent. */
  popup: boolean;
  /** The sandbox it loads through; none for this machine's. */
  sandbox?: BrowserSandbox;
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

/** Every page's: Chromium's sandbox, and nothing of Electron's or Node's reaching it. Its preload
 *  (page-preload.ts) only hands main the key presses the page left alone, in a world of its own. */
const PAGE_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  spellcheck: false,
  preload: path.join(__dirname, "page-preload.js"),
};

/** Where an empty page paints nothing, TET's tab beneath it shows, in its editor tab's color, not
 *  Chromium's own (#121212 in the dark); a page of the web gets Chrome's white beneath its own. */
const BLANK_BACKGROUND = "#00000000";
const PAGE_BACKGROUND = "#ffffff";

/** The still a page under something of the window is shown as (`still`): JPEG, as VS Code's. */
const STILL_QUALITY = 80;

/** The tabs a repository's or worktree's pages may have opened at once: Chromium's popup blocker,
 *  which lets a popup through only after the user's input, is Chrome's and not Electron's, so a page
 *  opening them in a loop would otherwise open them without end. */
const MAX_POPUPS = 10;

/** The downloads `browser-downloads` keeps, the newest. */
const MAX_DOWNLOADS = 200;

/** Chromium's code for a load a newer one replaced: no failure. */
const ERR_ABORTED = -3;

/** How long `load` waits for a page; one still loading then is no failure, the agent reads it on. */
const LOAD_WAIT_MS = 30_000;

/** A worktree's profile folder, as Chromium spells `partitionOf`'s name on disk: in lower case. */
const WORKTREE_PROFILE = /^tet-([0-9a-f-]{36})-([0-9a-f]+)$/;

/** A sandbox's profile folder (`partitionOf`): its project, its worktree's key or `repository`, its
 *  agent. */
const SANDBOX_PROFILE = /^tet-sbx-([0-9a-f-]{36})-([0-9a-f]+|repository)-(.+)$/;

/** Chromium's code for a certificate whose issuer it does not trust. */
const ERR_CERT_AUTHORITY_INVALID = -202;

/**
 * Chromium's own user agent from Electron's, which adds the app's token and its own
 * (`… tet-ide/43.4.0 Chrome/… Electron/43.4.0 …`): sign-in pages refuse a browser so named as an
 * embedded one.
 */
export function chromiumUserAgent(electron: string): string {
  return electron.replace(/ Electron\/\S+/, "").replace(/(\(KHTML, like Gecko\)) (?:\S+\/\S+ )*?(Chrome\/)/, "$1 $2");
}

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
  return `${isLoopbackHost(hostnameOf(`http://${url}`)) ? "http" : "https"}://${url}`;
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
  /** The logins the pages asked for, until answered or their tab goes. */
  private readonly logins = new Map<number, { tabId: string; answer: (username?: string, password?: string) => void }>();
  private asked = 0;
  private readonly downloaded: BrowserDownload[] = [];
  private created = 0;
  /** By partition, each sandbox's way out (SandboxRoute) while it has tabs; one that failed is
   *  forgotten, to be tried again by the next tab. */
  private readonly routes = new Map<string, Promise<SandboxRoute>>();
  /** Per `refKey`, the repositories and worktrees whose pages changed this turn (`changed`). */
  private readonly due = new Map<string, ProjectRef>();
  /** Per `refKey`, the tabs last sent to the window, as JSON (`sendTabs`). */
  private readonly sent = new Map<string, string>();

  constructor(private readonly deps: BrowserTabsDeps) {}

  /** Every tab of the repository or worktree, for the window; a browser verb's `scope` alone. */
  list(ref: ProjectRef, scope?: BrowserScope): BrowserTabInfo[] {
    return this.of(ref, scope).map(infoOf);
  }

  /** `tabId` of the repository or worktree within `scope`, else its active tab there, else its last
   *  opened there. */
  page(ref: ProjectRef, tabId: string | undefined, scope: BrowserScope): BrowserPage | undefined {
    const inScope = (tab: Tab | undefined): Tab | undefined => (tab && inside(tab, scope) ? tab : undefined);
    const tab =
      tabId === undefined
        ? (inScope(this.find(ref, this.active.get(refKeyOf(ref)))) ?? this.of(ref, scope).at(-1))
        : inScope(this.find(ref, tabId));
    return tab && pageOf(tab);
  }

  /** Any repository's or worktree's. */
  pageById(tabId: string): BrowserPage | undefined {
    const tab = this.tabs.get(tabId);
    return tab && pageOf(tab);
  }

  /** A new tab loading `typed` (browserUrl), made the active one, through `sandbox` where given;
   *  `loaded` settles as `load` does. */
  create(ref: ProjectRef, typed: string, sandbox?: BrowserSandbox): { tab: BrowserTabInfo; loaded: Promise<void> } {
    const url = browserUrl(typed);
    const tab = this.open(ref, this.newView(ref, sandbox), false, sandbox);
    const loaded = this.load(tab, url);
    this.sendTabs(ref);
    return { tab: infoOf(tab), loaded };
  }

  /** A page in the profile of the repository or worktree, or of its sandbox. */
  private newView(ref: ProjectRef, sandbox: BrowserSandbox | undefined): WebContentsView {
    return new WebContentsView({ webPreferences: { session: this.profileOf(ref, sandbox), ...PAGE_PREFERENCES } });
  }

  /**
   * `load` once the tab's way out is in place: a sandbox's tab loads nothing before its profile
   * goes through the sandbox, and nothing at all when the sandbox cannot be reached — never from
   * this machine. A failure names what the sandbox's proxy refused.
   */
  private async load(tab: Tab, url: string): Promise<void> {
    if (tab.sandbox) {
      await this.routeOf(tab.ref, tab.sandbox);
    }
    try {
      await loadPage(tab, url);
    } catch (error) {
      const refused = await this.refusalOf(tab, url);
      throw refused === undefined ? error : new Error(`${errorMessage(error)}: ${refused}`);
    }
  }

  /** `view` as a tab of the repository or worktree, made the active one: a new page, or a popup a
   *  page opened, of the sandbox its opener loads through. */
  private open(ref: ProjectRef, view: WebContentsView, popup: boolean, sandbox: BrowserSandbox | undefined): Tab {
    const tab: Tab = { tabId: `${BROWSER_TAB_PREFIX}${++this.created}`, ref, view, popup, sandbox };
    /** Told once that a popup was blocked, not once per popup. */
    let blocked = false;
    const changed = (): void => this.changed(ref);
    view.setVisible(false);
    view.setBackgroundColor(BLANK_BACKGROUND);
    if (sandbox) {
      // WebRTC's UDP takes no proxy: it would leave from this machine, past the sandbox's policy.
      view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    }
    view.webContents.on("did-start-loading", changed);
    view.webContents.on("did-stop-loading", changed);
    view.webContents.on("page-title-updated", changed);
    view.webContents.on("did-navigate", (_event, url) => {
      view.setBackgroundColor(url === "about:blank" ? BLANK_BACKGROUND : PAGE_BACKGROUND);
      changed();
    });
    view.webContents.on("did-navigate-in-page", changed);
    view.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) {
        void this.refusalOf(tab, failedUrl).then((refused) =>
          this.deps.notice("warning", `Could not load ${failedUrl}: ${description}${refused === undefined ? "" : ` (${refused})`}`),
        );
      }
    });
    // A popup or a link to a new window opens as a tab of the same repository or worktree, in its
    // profile, and stays its opener's: a sign-in popup hands its answer back (`window.opener`).
    view.webContents.setWindowOpenHandler(({ url: opened }) => {
      try {
        browserUrl(opened);
      } catch {
        // Not a web address: nothing opens.
        return { action: "deny" };
      }
      if (this.of(ref, undefined).filter((held) => held.popup).length >= MAX_POPUPS) {
        if (!blocked) {
          blocked = true;
          this.deps.notice("warning", `Blocked a popup of ${view.webContents.getURL()}: its pages opened ${MAX_POPUPS} tabs already`);
        }
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: { webPreferences: PAGE_PREFERENCES },
        // Electron hands over the popup's page (`webContents`), which its types leave out.
        createWindow: ({
          webContents: page,
          webPreferences,
        }: Electron.BrowserWindowConstructorOptions & { webContents?: Electron.WebContents }) => {
          // A link opened in the background (a middle click) comes without its page: loaded anew.
          const popup = page
            ? this.open(ref, new WebContentsView({ webContents: page, webPreferences }), true, sandbox)
            : this.open(ref, this.newView(ref, sandbox), true, sandbox);
          if (!page) {
            this.load(popup, browserUrl(opened)).catch(() => undefined);
          }
          this.sendTabs(ref);
          this.deps.onOpened(ref, popup.tabId);
          // Electron takes the popup's page back; nothing is sent through it.
          // eslint-disable-next-line no-restricted-syntax
          return popup.view.webContents;
        },
      };
    });
    // A page closing itself (`window.close()`, a sign-in popup done) closes its tab.
    view.webContents.once("destroyed", () => {
      if (this.tabs.get(tab.tabId) === tab) {
        this.dispose(tab, false);
        this.sendTabs(ref);
      }
    });
    // A dev server's own certificate is taken on a local host, as Chrome's allow-insecure-localhost
    // takes it; anywhere else Chromium's refusal stands.
    view.webContents.on("certificate-error", (event, failedUrl, _error, _certificate, callback) => {
      const local = isLoopbackHost(hostnameOf(failedUrl));
      if (local) {
        event.preventDefault();
      }
      callback(local);
    });
    // As a browser's own sign-in box: the tab asks the user, the one question a page puts.
    view.webContents.on("login", (event, _details, authInfo, callback) => {
      event.preventDefault();
      const id = ++this.asked;
      this.logins.set(id, { tabId: tab.tabId, answer: callback });
      this.deps.onLogin(ref, tab.tabId, { id, host: authInfo.host, realm: authInfo.realm, proxy: authInfo.isProxy });
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
    view.webContents.on("focus", () => this.deps.onFocused(ref, tab.tabId));
    // The page's own DevTools, as F12 opens TET's for the window (window.ts); taken before the page,
    // as Chrome takes it.
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "F12") {
        event.preventDefault();
        if (view.webContents.isDevToolsOpened()) {
          view.webContents.closeDevTools();
        } else {
          openDevTools(view);
        }
      }
    });
    this.deps.host.addView(view);
    this.tabs.set(tab.tabId, tab);
    this.active.set(refKeyOf(ref), tab.tabId);
    return tab;
  }

  /** Loads `typed` (browserUrl) in the tab; rejects with Chromium's reason when it cannot. */
  async navigate(ref: ProjectRef, tabId: string, typed: string): Promise<void> {
    const tab = this.find(ref, tabId);
    if (!tab) {
      throw new Error(`no browser tab ${tabId}`);
    }
    await this.load(tab, browserUrl(typed));
  }

  go(ref: ProjectRef, tabId: string, where: BrowserGo): void {
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

  /**
   * A key the page left alone (page-preload.ts), from the page `senderId` names: a window shortcut
   * the window then takes. One a page handled stays the page's, as in VS Code's browser.
   */
  pageKey(senderId: number, key: ShortcutKey): void {
    const tab = [...this.tabs.values()].find((held) => held.view.webContents.id === senderId);
    const shortcut = tab && isShortcutKey(key) ? shortcutOf(key, PLATFORM) : undefined;
    if (shortcut) {
      this.deps.onShortcut(shortcut);
    }
  }

  /** A login the user typed for a page's request, or none: the page then shows its refusal. */
  answerLogin(id: number, login: BrowserCredentials | null): void {
    const asked = this.logins.get(id);
    this.logins.delete(id);
    if (login) {
      asked?.answer(login.username, login.password);
    } else {
      asked?.answer();
    }
  }

  close(ref: ProjectRef, tabId: string): void {
    const tab = this.find(ref, tabId);
    if (tab) {
      this.dispose(tab);
      this.sendTabs(ref);
    }
  }

  /** The window closed: every tab goes with it, their pages drawn nowhere else. */
  closeEverything(): void {
    [...this.tabs.values()].forEach((tab) => this.dispose(tab));
    this.active.clear();
    this.due.clear();
    this.sent.clear();
  }

  /** The repository or worktree closed: every tab of it goes. */
  closeAll(ref: ProjectRef): void {
    this.of(ref, undefined).forEach((tab) => this.dispose(tab));
    const key = refKeyOf(ref);
    this.active.delete(key);
    this.due.delete(key);
    this.sent.delete(key);
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

  /** The page as it looks, a JPEG data URL, for the window to show in its place while something
   *  of it lies over the page (BrowserHost). Null when it has no look yet. */
  async still(ref: ProjectRef, tabId: string): Promise<string | null> {
    const image = await this.find(ref, tabId)?.view.webContents.capturePage();
    return image && !image.isEmpty() ? `data:image/jpeg;base64,${image.toJPEG(STILL_QUALITY).toString("base64")}` : null;
  }

  setActive(ref: ProjectRef, tabId: string): void {
    this.active.set(refKeyOf(ref), tabId);
  }

  /** A deleted worktree's logins, cookies and cache, and those of its sandboxes this run used; the
   *  global profile is never cleared. A failure is logged: the worktree is gone either way. */
  async clearProfile(ref: ProjectRef): Promise<void> {
    if (ref.worktree === undefined) {
      return;
    }
    const sandboxes = sandboxPartitionsOf(ref);
    const partitions = [partitionOf(ref), ...[...this.guarded].filter((partition) => partition.startsWith(sandboxes))];
    await Promise.all(
      partitions.map((partition) => {
        const profile = session.fromPartition(partition);
        return Promise.all([profile.clearStorageData(), profile.clearCache()]).catch((error: unknown) =>
          logError(`could not clear the browser profile of ${refKeyOf(ref)}`, error),
        );
      }),
    );
  }

  /** The way out of the sandbox's profile, put in place by its first tab: the profile loads through
   *  the sandbox's proxy, every loopback address included, which Chromium would otherwise dial
   *  itself. */
  private routeOf(ref: ProjectRef, sandbox: BrowserSandbox): Promise<SandboxRoute> {
    const partition = partitionOf(ref, sandbox);
    let route = this.routes.get(partition);
    if (!route) {
      const current = (): boolean => this.routes.get(partition) === route;
      route = this.deps.route(sandbox).then(async (opened) => {
        // Let go of meanwhile (its last tab closed): a newer route's proxy must not be replaced.
        if (!current()) {
          opened.close();
          throw new Error(`the browser tabs of ${sandbox.name} closed`);
        }
        await session.fromPartition(partition).setProxy({ proxyRules: `127.0.0.1:${opened.port}`, proxyBypassRules: "<-loopback>" });
        return opened;
      });
      this.routes.set(partition, route);
      route.catch(() => {
        if (this.routes.get(partition) === route) {
          this.routes.delete(partition);
        }
      });
    }
    return route;
  }

  /** Why the sandbox's proxy refused the host of `url`, for a tab of a sandbox. */
  private async refusalOf(tab: Tab, url: string): Promise<string | undefined> {
    const route = tab.sandbox && this.routes.get(partitionOf(tab.ref, tab.sandbox));
    try {
      return route && (await route).refusal(new URL(url).hostname);
    } catch {
      return undefined;
    }
  }

  /** The profile of the repository or worktree, or of its sandbox: its permissions answered and its
   *  user agent Chromium's from its first tab on; a sandbox's trusts its proxy's certificate too. */
  private profileOf(ref: ProjectRef, sandbox: BrowserSandbox | undefined): Electron.Session {
    const partition = partitionOf(ref, sandbox);
    const profile = session.fromPartition(partition);
    if (!this.guarded.has(partition)) {
      this.guarded.add(partition);
      if (sandbox) {
        profile.setCertificateVerifyProc((request, callback) => {
          if (request.errorCode !== ERR_CERT_AUTHORITY_INVALID) {
            callback(-3);
            return;
          }
          void this.routes
            .get(partition)
            ?.then((route) => route.ca)
            .catch(() => undefined)
            .then((ca) => callback(ca !== undefined && issuedBy(request.certificate, request.hostname, ca) ? 0 : -3));
        });
      }
      // A link to mail leaves for the mail app, as one in TET's own page does (window.ts).
      profile.setPermissionRequestHandler((_contents, permission, callback, details) =>
        callback(
          GRANTED_PERMISSIONS.has(permission) ||
            (permission === "openExternal" && "externalURL" in details && isOpenableUrl(details.externalURL ?? "")),
        ),
      );
      profile.setPermissionCheckHandler((_contents, permission) => GRANTED_PERMISSIONS.has(permission));
      profile.setUserAgent(chromiumUserAgent(profile.getUserAgent()));
      profile.on("will-download", (_event, item, contents) => this.download(item, contents));
    }
    return profile;
  }

  /** What the repository's or worktree's pages within `scope` downloaded during this run, the oldest
   *  first, of the last MAX_DOWNLOADS. */
  downloads(ref: ProjectRef, scope: BrowserScope): BrowserDownload[] {
    return this.downloaded
      .filter((download) => sameProjectRef(download.ref, ref) && download.sandbox === scope.sandbox)
      .map((download) => ({ ...download }));
  }

  /** Saved without a question into the project's downloads folder, as Chrome saves into the
   *  user's — a sandbox's tab's then handed into its agent folder, which it sees (`handOver`); a
   *  notice says where once it is there. */
  private download(item: Electron.DownloadItem, contents: Electron.WebContents): void {
    const tab = [...this.tabs.values()].find((held) => held.view.webContents.id === contents.id);
    if (!tab) {
      item.cancel();
      return;
    }
    const { sandbox } = tab;
    const dir = downloadsDir(this.deps.dataRoot, tab.ref.projectId);
    fs.mkdirSync(dir, { recursive: true });
    const saved = freePath(dir, item.getFilename(), this.downloaded);
    const download: BrowserDownload = {
      ref: tab.ref,
      sandbox: sandbox?.name,
      // A sandbox's where it will land, settled once there.
      path: sandbox ? path.join(sandbox.downloadsDir, path.basename(saved)) : saved,
      url: item.getURL(),
      state: "progressing",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
    };
    item.setSavePath(saved);
    this.downloaded.push(download);
    this.downloaded.splice(0, this.downloaded.length - MAX_DOWNLOADS);
    item.on("updated", () => {
      download.receivedBytes = item.getReceivedBytes();
      download.totalBytes = item.getTotalBytes();
    });
    item.once("done", (_event, state) => {
      download.receivedBytes = item.getReceivedBytes();
      const name = path.basename(saved);
      const settled = (final: BrowserDownload["state"], where: string): void => {
        download.state = final;
        if (final === "completed") {
          this.deps.notice("info", `Downloaded ${name} to ${where}`);
        } else if (final === "interrupted") {
          this.deps.notice("warning", `Could not download ${name}`);
        }
      };
      if (!sandbox || state !== "completed") {
        settled(state, dir);
        if (sandbox) {
          void fs.promises.rm(saved, { force: true }).catch(() => undefined);
        }
        return;
      }
      void handOver(saved, sandbox)
        .then(
          (handed) => {
            download.path = handed;
            settled("completed", path.dirname(handed));
          },
          (error: unknown) => {
            logError(`could not hand ${saved} to ${sandbox.name}`, error);
            settled("interrupted", dir);
          },
        )
        .finally(() => fs.promises.rm(saved, { force: true }).catch(() => undefined));
    });
  }

  /** Every tab of the repository or worktree, or those within `scope`. */
  private of(ref: ProjectRef, scope: BrowserScope | undefined): Tab[] {
    return [...this.tabs.values()].filter((tab) => sameProjectRef(tab.ref, ref) && (scope === undefined || inside(tab, scope)));
  }

  private find(ref: ProjectRef, tabId: string | undefined): Tab | undefined {
    const tab = tabId === undefined ? undefined : this.tabs.get(tabId);
    return tab && sameProjectRef(tab.ref, ref) ? tab : undefined;
  }

  /** `closePage` false for a page already gone, whose view then holds none. */
  private dispose(tab: Tab, closePage = true): void {
    this.tabs.delete(tab.tabId);
    for (const [id, asked] of this.logins) {
      if (asked.tabId === tab.tabId) {
        this.logins.delete(id);
      }
    }
    this.deps.onClosed(tab.tabId);
    this.deps.host.removeView(tab.view);
    if (closePage) {
      tab.view.webContents.close();
    }
    // A sandbox's last tab lets go of its relay, which holds the sandbox running; its profile keeps
    // the proxy gone, so nothing loads from this machine meanwhile.
    const { sandbox } = tab;
    if (sandbox && ![...this.tabs.values()].some((held) => held.sandbox?.name === sandbox.name && sameProjectRef(held.ref, tab.ref))) {
      const partition = partitionOf(tab.ref, sandbox);
      const route = this.routes.get(partition);
      this.routes.delete(partition);
      route?.then((opened) => opened.close()).catch(() => undefined);
    }
  }

  /** A page's own change (its loading, title or address): sent once the events of this turn are
   *  in, as one load fires several. */
  private changed(ref: ProjectRef): void {
    if (this.due.size === 0) {
      setImmediate(() => {
        const due = [...this.due.values()];
        this.due.clear();
        due.forEach((each) => this.sendTabs(each));
      });
    }
    this.due.set(refKeyOf(ref), ref);
  }

  /** The repository's or worktree's tabs to the window, now — before a tab opened is shown or a
   *  closed one forgotten — unless they are as last sent. */
  private sendTabs(ref: ProjectRef): void {
    const key = refKeyOf(ref);
    const tabs = this.list(ref);
    const sent = JSON.stringify(tabs);
    if (this.sent.get(key) !== sent) {
      this.sent.set(key, sent);
      this.deps.onTabs(ref, tabs);
    }
  }
}

/** Settles once the page has loaded, or after LOAD_WAIT_MS while it still loads; rejects with
 *  Chromium's reason for a page that cannot load. */
function loadPage(tab: Tab, url: string): Promise<void> {
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

/**
 * A sandbox's download, moved from where Chromium saved it into the sandbox's downloads folder:
 * written only inside its agent folder, links resolved (openInside), and never over a file there —
 * the sandbox writes that folder too, and a link it left would have Chromium write anywhere on this
 * machine. Answers where it landed.
 */
export async function handOver(saved: string, sandbox: Pick<BrowserSandbox, "agentDir" | "downloadsDir">): Promise<string> {
  await fs.promises.mkdir(sandbox.downloadsDir, { recursive: true });
  const target = freePath(sandbox.downloadsDir, path.basename(saved), []);
  const handle = await openInside(sandbox.agentDir, target, "wx");
  try {
    for await (const chunk of fs.createReadStream(saved)) {
      await handle.write(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }
  return target;
}

/** What a page's preload sent as a key press, checked: the page's process is not TET's. */
function isShortcutKey(key: unknown): key is ShortcutKey {
  if (typeof key !== "object" || key === null) {
    return false;
  }
  const fields = key as Record<string, unknown>;
  return (
    typeof fields.key === "string" &&
    typeof fields.code === "string" &&
    ["shiftKey", "altKey", "ctrlKey", "metaKey"].every((name) => typeof fields[name] === "boolean")
  );
}

/** `name` in `dir`, or as Chrome numbers one already there or still downloading: `name (1).ext`. */
function freePath(dir: string, name: string, downloads: readonly BrowserDownload[]): string {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const taken = (candidate: string): boolean =>
    fs.existsSync(candidate) || downloads.some((download) => download.state === "progressing" && download.path === candidate);
  let candidate = path.join(dir, name);
  for (let count = 1; taken(candidate); count++) {
    candidate = path.join(dir, `${stem} (${count})${extension}`);
  }
  return candidate;
}

/** The host name of `url`, "" for one that is no URL. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
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
    const owned = new Map<string, ReadonlySet<string>>();
    const ownedBy = (projectId: string): ReadonlySet<string> => {
      let keys = owned.get(projectId);
      if (!keys) {
        keys = new Set(ownedWorktreeKeys(dataRoot, projectId));
        owned.set(projectId, keys);
      }
      return keys;
    };
    await Promise.all(
      names.map(async (name) => {
        const sandbox = SANDBOX_PROFILE.exec(name);
        const match = sandbox ? null : WORKTREE_PROFILE.exec(name);
        const gone = sandbox
          ? !fs.existsSync(
              sandboxDir(dataRoot, { projectId: sandbox[1], worktree: sandbox[2] === "repository" ? undefined : sandbox[2] }, sandbox[3]),
            )
          : match !== null && !ownedBy(match[1]).has(match[2]);
        if (!gone) {
          return;
        }
        await fs.promises
          .rm(path.join(root, name), { recursive: true, force: true })
          .catch((error: unknown) => logError(`could not delete the browser profile ${name}`, error));
      }),
    );
  })();
}

/** A worktree's own profile, or the global one of every repository; a sandbox's own (SANDBOX_PROFILE). */
function partitionOf(ref: ProjectRef, sandbox?: BrowserSandbox): string {
  if (sandbox) {
    return `${sandboxPartitionsOf(ref)}${sandbox.agentId}`;
  }
  return ref.worktree === undefined ? "persist:tet-global" : `persist:tet-${ref.projectId}-${ref.worktree}`;
}

/** What the profiles of the repository's or worktree's sandboxes begin with. */
function sandboxPartitionsOf(ref: ProjectRef): string {
  return `persist:tet-sbx-${ref.projectId}-${ref.worktree ?? "repository"}-`;
}

function inside(tab: Tab, scope: BrowserScope): boolean {
  return tab.sandbox?.name === scope.sandbox;
}

/**
 * Whether the sandbox's proxy signed the site's certificate, as it signs every HTTPS site the
 * sandbox reaches: issued and signed by `ca` itself, for `hostname` (a name or an address), and both valid now. Anything
 * else keeps Chromium's refusal.
 */
export function issuedBy(certificate: Electron.Certificate, hostname: string, ca: string): boolean {
  try {
    const authority = new crypto.X509Certificate(ca);
    const site = new crypto.X509Certificate(certificate.data);
    const now = Date.now();
    const valid = (cert: crypto.X509Certificate): boolean => cert.validFromDate.getTime() <= now && now <= cert.validToDate.getTime();
    return (
      authority.ca &&
      valid(authority) &&
      valid(site) &&
      site.checkIssued(authority) &&
      site.verify(authority.publicKey) &&
      (net.isIP(hostname) === 0 ? site.checkHost(hostname) : site.checkIP(hostname)) !== undefined
    );
  } catch {
    return false;
  }
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
    sandboxed: tab.sandbox !== undefined,
    url: tab.view.webContents.getURL(),
    title: tab.view.webContents.getTitle(),
    loading: tab.view.webContents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}
