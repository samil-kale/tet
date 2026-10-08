import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserUrl } from "../../src/main/browser/browser-tabs";
import { CdpProxy, type CdpMessage } from "../../src/main/browser/cdp-proxy";
import type { BrowserPage } from "../../src/main/browser/browser-tabs";

/** browser/: what an address typed becomes, and one tab's page as a whole browser over CDP. */

describe("browserUrl", () => {
  it("takes the web as typed and gives a bare host its scheme, http for this machine", () => {
    assert.equal(browserUrl("https://example.com/a"), "https://example.com/a");
    assert.equal(browserUrl("http://localhost:3000"), "http://localhost:3000");
    assert.equal(browserUrl("localhost:3000/login"), "http://localhost:3000/login");
    assert.equal(browserUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
    assert.equal(browserUrl("example.com"), "https://example.com");
    assert.equal(browserUrl(" "), "about:blank");
  });

  it("refuses every other scheme", () => {
    for (const typed of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings"]) {
      assert.throws(() => browserUrl(typed), /not a web address/, typed);
    }
  });
});

/** Electron's debugger of one page: what it was sent, and a way to fire its events. */
function fakePage() {
  const sent: [string, unknown, string | undefined][] = [];
  const listeners: ((event: unknown, method: string, params: unknown, sessionId?: string) => void)[] = [];
  let attached = false;
  const page: BrowserPage = {
    tabId: "tet:browser:1",
    targetId: "T1",
    url: "http://localhost:3000/",
    title: "App",
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
      },
      sendCommand: async (method: string, params?: unknown, sessionId?: string) => {
        sent.push([method, params, sessionId]);
        return { answered: method };
      },
      on: (_name: string, listener: (typeof listeners)[number]) => listeners.push(listener),
      removeListener: (_name: string, listener: (typeof listeners)[number]) => listeners.splice(listeners.indexOf(listener), 1),
    } as unknown as BrowserPage["debugger"],
  };
  const fire = (method: string, params: unknown, sessionId?: string): void =>
    listeners.forEach((listener) => listener({}, method, params, sessionId));
  return { page, sent, fire, attached: () => attached, listening: () => listeners.length };
}

describe("CdpProxy", () => {
  /** A proxy over a fake page, and every message it sent the client. */
  const proxied = () => {
    const fake = fakePage();
    const out: CdpMessage[] = [];
    return { ...fake, out, proxy: new CdpProxy(fake.page, (message) => out.push(message)) };
  };

  it("serves the browser's domains itself and announces the one page on auto-attach", async () => {
    const { proxy, out, sent, attached } = proxied();
    await proxy.handle({ id: 1, method: "Browser.getVersion" });
    assert.equal((out[0].result as { protocolVersion: string }).protocolVersion, "1.3");
    await proxy.handle({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } });
    const announced = out.find((message) => message.method === "Target.attachedToTarget");
    assert.deepEqual((announced?.params as { sessionId: string }).sessionId, "tet-page-T1");
    assert.equal(
      (announced?.params as { targetInfo: { browserContextId?: string } }).targetInfo.browserContextId,
      "tet",
      "Playwright needs one",
    );
    assert.ok(attached(), "the debugger attached on the client's first sight of the page");
    assert.deepEqual(sent, [], "nothing of the browser's reached the page");
    await proxy.handle({ id: 3, method: "Target.createTarget", params: { url: "about:blank" } });
    assert.ok(out.at(-1)?.error, "no page of its own: a tab opens in the window");
  });

  it("hands the page's session to the debugger, and the frames' by their own ids", async () => {
    const { proxy, out, sent, fire } = proxied();
    await proxy.handle({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } });
    await proxy.handle({ id: 2, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "tet-page-T1" });
    assert.deepEqual(sent[0], ["Runtime.evaluate", { expression: "1" }, undefined]);
    assert.deepEqual(out.at(-1), { id: 2, result: { answered: "Runtime.evaluate" }, sessionId: "tet-page-T1" });
    // An iframe the page attached below it: its events and commands keep Chromium's session id.
    fire("Target.attachedToTarget", { sessionId: "F1", targetInfo: { type: "iframe" } });
    assert.deepEqual(out.at(-1)?.sessionId, "tet-page-T1", "the page's own event, on the page's session");
    fire("Runtime.consoleAPICalled", { type: "log" }, "F1");
    assert.equal(out.at(-1)?.sessionId, "F1");
    await proxy.handle({ id: 3, method: "DOM.enable", sessionId: "F1" });
    assert.deepEqual(sent.at(-1), ["DOM.enable", undefined, "F1"]);
    await proxy.handle({ id: 4, method: "DOM.enable", sessionId: "elsewhere" });
    assert.ok(out.at(-1)?.error, "a session the page never attached");
  });

  it("announces the page gone on close and lets go of the debugger it attached", async () => {
    const { proxy, out, attached, listening } = proxied();
    await proxy.handle({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } });
    await proxy.handle({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } });
    proxy.close();
    assert.deepEqual(
      out.slice(-2).map((message) => message.method),
      ["Target.detachedFromTarget", "Target.targetDestroyed"],
    );
    assert.ok(!attached());
    assert.equal(listening(), 0);
  });
});
