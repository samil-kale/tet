import type { BrowserPage } from "./browser-tabs";

/** One CDP message, either way: a command `{ id, method, params }`, its answer `{ id, result }` or
 *  `{ id, error }`, or an event `{ method, params }`; `sessionId` names the session it belongs to. */
export interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** CDP's code for a method this side does not serve. */
const METHOD_NOT_FOUND = -32601;
const SERVER_ERROR = -32000;

/**
 * One page of a browser tab as a whole browser over CDP, for Playwright's `connectOverCDP` in the
 * browser process (browser-automation.ts): Electron's `webContents.debugger` speaks to a page, not a
 * browser, so the browser's and the targets' domains are answered here, and everything else is
 * handed to the page's debugger. One proxy per tab, so the client sees that one page and nothing of
 * the window or another tab.
 *
 * The page's own session is `pageSession`; the frames and workers the page attaches below it keep
 * the debugger's session ids, flattened, as Chromium hands them out.
 */
export class CdpProxy {
  private readonly pageSession: string;
  /** The page is announced as attached (`Target.attachedToTarget`). */
  private attached = false;
  /** This proxy attached the debugger, and detaches it when it ends. */
  private ownsDebugger = false;
  private discover = false;
  private readonly children = new Set<string>();

  constructor(
    private readonly page: BrowserPage,
    private readonly send: (message: CdpMessage) => void,
  ) {
    this.pageSession = `tet-page-${page.targetId}`;
  }

  /** A command from the client, answered through `send`; never rejects. */
  async handle(request: CdpMessage): Promise<void> {
    const { id, method = "", params, sessionId } = request;
    try {
      const result =
        sessionId === undefined || method.startsWith("Browser.")
          ? this.browserCommand(method, params)
          : await this.pageCommand(method, params, sessionId);
      this.send({ id, result: result ?? {}, sessionId });
    } catch (error) {
      const code = error instanceof CdpError ? error.code : SERVER_ERROR;
      this.send({ id, error: { code, message: error instanceof Error ? error.message : String(error) }, sessionId });
    }
  }

  /** The tab closed, or the client went: the page is announced gone, the debugger let go. */
  close(): void {
    if (this.attached) {
      this.send({ method: "Target.detachedFromTarget", params: { sessionId: this.pageSession, targetId: this.page.targetId } });
    }
    if (this.discover) {
      this.send({ method: "Target.targetDestroyed", params: { targetId: this.page.targetId } });
    }
    this.release();
  }

  /** Lets go of the debugger without telling the client, which is gone. */
  release(): void {
    this.page.debugger.removeListener("message", this.onMessage);
    if (this.ownsDebugger && this.page.debugger.isAttached()) {
      this.page.debugger.detach();
    }
    this.attached = false;
    this.ownsDebugger = false;
  }

  private browserCommand(method: string, params: unknown): unknown {
    const args = (params ?? {}) as { targetId?: string; sessionId?: string; autoAttach?: boolean; discover?: boolean };
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: `Chrome/${process.versions.chrome}`,
          revision: "",
          userAgent: "",
          jsVersion: process.versions.v8,
        };
      // The window and its profile are TET's: what Playwright sets up on a browser of its own is
      // acknowledged and left alone.
      case "Browser.setDownloadBehavior":
      case "Browser.grantPermissions":
      case "Browser.resetPermissions":
      case "Browser.setWindowBounds":
      case "Browser.close":
        return {};
      case "Browser.getWindowForTarget":
        return { windowId: 1, bounds: { windowState: "normal" } };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.getTargets":
        return { targetInfos: [this.targetInfo()] };
      case "Target.getTargetInfo":
        return args.targetId === this.page.targetId
          ? { targetInfo: this.targetInfo() }
          : { targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true } };
      case "Target.setDiscoverTargets":
        if (args.discover === true && !this.discover) {
          this.send({ method: "Target.targetCreated", params: { targetInfo: this.targetInfo() } });
        }
        this.discover = args.discover === true;
        return {};
      case "Target.setAutoAttach":
        if (args.autoAttach === true) {
          this.attach();
        }
        return {};
      case "Target.attachToTarget":
        if (args.targetId !== this.page.targetId) {
          throw new CdpError(SERVER_ERROR, `no target ${args.targetId}`);
        }
        this.attach();
        return { sessionId: this.pageSession };
      case "Target.detachFromTarget":
        if (args.sessionId === this.pageSession) {
          this.close();
        }
        return {};
      default:
        throw new CdpError(METHOD_NOT_FOUND, `${method} is not served here`);
    }
  }

  private pageCommand(method: string, params: unknown, sessionId: string): Promise<unknown> {
    if (sessionId !== this.pageSession && !this.children.has(sessionId)) {
      return Promise.reject(new CdpError(SERVER_ERROR, `no session ${sessionId}`));
    }
    // Crashes Electron's view at times; the tab's size is the window's anyway.
    if (method === "Emulation.setDeviceMetricsOverride") {
      return Promise.resolve({});
    }
    return this.page.debugger.sendCommand(method, params, sessionId === this.pageSession ? undefined : sessionId);
  }

  private attach(): void {
    if (this.attached) {
      return;
    }
    if (!this.page.debugger.isAttached()) {
      this.page.debugger.attach("1.3");
      this.ownsDebugger = true;
    }
    this.page.debugger.on("message", this.onMessage);
    this.attached = true;
    this.send({
      method: "Target.attachedToTarget",
      params: { sessionId: this.pageSession, targetInfo: this.targetInfo(), waitingForDebugger: false },
    });
  }

  /** An event of the page, or of a frame or worker below it, to the client. */
  private readonly onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string): void => {
    if (method === "Target.attachedToTarget" && !sessionId) {
      this.children.add((params as { sessionId: string }).sessionId);
    } else if (method === "Target.detachedFromTarget" && !sessionId) {
      this.children.delete((params as { sessionId: string }).sessionId);
    }
    this.send({ method, params, sessionId: sessionId || this.pageSession });
  };

  private targetInfo(): object {
    return {
      targetId: this.page.targetId,
      type: "page",
      title: this.page.title,
      url: this.page.url,
      attached: this.attached,
      canAccessOpener: false,
      // Playwright requires one; a context it never made is its default one.
      browserContextId: "tet",
    };
  }
}

class CdpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
