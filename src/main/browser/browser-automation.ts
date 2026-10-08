import { chromium, type ConnectOverCDPTransport, type Locator, type Page } from "playwright-core";

/**
 * What the `tet-ctl browser-*` verbs do on a page, through Playwright, in the browser's own process
 * (browser-host.ts, started by browser-client.ts): Playwright's protocol work stays off the main
 * process, which relays the terminals' output. Each tab is a browser of its own to Playwright,
 * reached through main's CDP proxy (cdp-proxy.ts) over the port `usePort` is handed. Nothing here
 * may import electron.
 */

/** Either way over the port: a CDP message of the tab's connection, or its end. */
export interface CdpEnvelope {
  tabId: string;
  message?: object;
  closed?: true;
}

/** How long an action waits for its element, a wait for its text or address. */
const ACTION_TIMEOUT_MS = 10_000;
/** The console lines kept per tab until `consoleMessages` takes them. */
const MAX_CONSOLE_LINES = 200;

let port: Electron.MessagePortMain | undefined;
const transports = new Map<string, ConnectOverCDPTransport>();
const pages = new Map<string, Promise<Page>>();
const consoles = new Map<string, string[]>();

/** The channel to main's proxies; a process restarted by its client gets a new one. */
export function usePort(next: Electron.MessagePortMain): void {
  port = next;
  next.on("message", (event) => {
    const { tabId, message, closed } = event.data as CdpEnvelope;
    const transport = transports.get(tabId);
    if (closed) {
      transport?.onclose?.("the tab closed");
    } else if (message) {
      transport?.onmessage?.(message);
    }
  });
  next.start();
}

/** The tab's page, connected on its first verb and kept while its connection stands. */
async function pageOf(tabId: string): Promise<Page> {
  const held = await pages.get(tabId)?.catch(() => undefined);
  if (held && !held.isClosed()) {
    return held;
  }
  const connecting = connect(tabId);
  pages.set(tabId, connecting);
  connecting.catch(() => {
    if (pages.get(tabId) === connecting) {
      pages.delete(tabId);
    }
  });
  return connecting;
}

/** An element by its `[ref=eN]` of the page's last snapshot; one gone fails at once rather than
 *  waiting for it. */
async function locate(tabId: string, element: string): Promise<Locator> {
  const locator = (await pageOf(tabId)).locator(`aria-ref=${element}`);
  if ((await locator.count()) === 0) {
    throw new Error(`no element ${element} on the page: take a new browser-snapshot`);
  }
  return locator;
}

async function connect(tabId: string): Promise<Page> {
  const transport: ConnectOverCDPTransport = {
    send: (message) => port?.postMessage({ tabId, message } satisfies CdpEnvelope),
    close: () => port?.postMessage({ tabId, closed: true } satisfies CdpEnvelope),
  };
  transports.set(tabId, transport);
  const browser = await chromium.connectOverCDP(transport);
  browser.on("disconnected", () => {
    if (transports.get(tabId) === transport) {
      pages.delete(tabId);
      transports.delete(tabId);
      consoles.delete(tabId);
    }
  });
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) {
    throw new Error("the tab's page could not be reached");
  }
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const lines: string[] = [];
  consoles.set(tabId, lines);
  const keep = (line: string): void => {
    lines.push(line);
    lines.splice(0, lines.length - MAX_CONSOLE_LINES);
  };
  page.on("console", (message) => keep(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => keep(`pageerror: ${error.message}`));
  return page;
}

/** The page's accessibility tree with a `[ref=eN]` on each element the other verbs take. */
export async function snapshot(tabId: string): Promise<{ url: string; title: string; snapshot: string }> {
  const page = await pageOf(tabId);
  return { url: page.url(), title: await page.title(), snapshot: await page.locator(":root").ariaSnapshot({ mode: "ai" }) };
}

export async function click(tabId: string, element: string): Promise<void> {
  await (await locate(tabId, element)).click();
}

export async function fill(tabId: string, element: string, text: string): Promise<void> {
  await (await locate(tabId, element)).fill(text);
}

/** Playwright's key names (`Enter`, `Control+a`), on whatever has the focus. */
export async function press(tabId: string, key: string): Promise<void> {
  await (await pageOf(tabId)).keyboard.press(key);
}

/** Until the page shows `text` and its address contains `url`, whichever are given. */
export async function waitFor(tabId: string, text: string | undefined, url: string | undefined): Promise<void> {
  const page = await pageOf(tabId);
  if (url !== undefined) {
    await page.waitForURL((address) => address.href.includes(url));
  }
  if (text !== undefined) {
    await page.getByText(text).first().waitFor();
  }
}

/** The console lines and page errors since the last call. */
export function consoleMessages(tabId: string): string[] {
  return consoles.get(tabId)?.splice(0) ?? [];
}
