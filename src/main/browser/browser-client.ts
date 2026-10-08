import { MessageChannelMain, type MessagePortMain, type UtilityProcess } from "electron";
import { utilityClient } from "../util/utility-client";
import type { CdpEnvelope } from "./browser-automation";
import type { BrowserPage } from "./browser-tabs";
import { CdpProxy } from "./cdp-proxy";

/**
 * browser-automation.ts in the browser's process (browser-host.ts), as seen from the main process,
 * started by the first browser verb. Its Playwright reaches each tab's page through a CDP proxy
 * here (cdp-proxy.ts), one per tab, over a port of its own beside the calls: `pageById` finds the
 * page a tab id names.
 */
export function browserAutomation(pageById: (tabId: string) => BrowserPage | undefined) {
  const proxies = new Map<string, CdpProxy>();
  let port: MessagePortMain | undefined;

  const post = (envelope: CdpEnvelope): void => port?.postMessage(envelope);

  /** The tab's proxy, made on its connection's first message; none for a tab gone. */
  const proxyOf = (tabId: string): CdpProxy | undefined => {
    const held = proxies.get(tabId);
    if (held) {
      return held;
    }
    const page = pageById(tabId);
    if (!page) {
      return undefined;
    }
    const proxy = new CdpProxy(page, (message) => post({ tabId, message }));
    proxies.set(tabId, proxy);
    return proxy;
  };

  // Each process forked gets a new port; the connections of one gone went with it.
  const onStart = (child: UtilityProcess): void => {
    for (const proxy of proxies.values()) {
      proxy.release();
    }
    proxies.clear();
    port?.close();
    const { port1, port2 } = new MessageChannelMain();
    port = port1;
    port1.on("message", (event) => {
      const { tabId, message, closed } = event.data as CdpEnvelope;
      if (closed) {
        proxies.get(tabId)?.release();
        proxies.delete(tabId);
        return;
      }
      const proxy = proxyOf(tabId);
      if (!proxy) {
        post({ tabId, closed: true });
        return;
      }
      void proxy.handle(message ?? {});
    });
    port1.start();
    child.postMessage({ port: true }, [port2]);
  };

  const client = utilityClient<typeof import("./browser-automation")>("browser", onStart);

  return {
    /** Every function of browser-automation.ts but `usePort`, which this side hands it itself. */
    api: client.api as Omit<typeof client.api, "usePort">,
    /** The tab closed: its page is announced gone to Playwright, the debugger let go. */
    tabClosed(tabId: string): void {
      const proxy = proxies.get(tabId);
      if (proxy) {
        proxy.close();
        proxies.delete(tabId);
        post({ tabId, closed: true });
      }
    },
    stop: client.stop,
  };
}

export type BrowserAutomation = ReturnType<typeof browserAutomation>;
