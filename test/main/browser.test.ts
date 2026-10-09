import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { bypassesProxy, proxyOf, serveRelay } from "../../src/cli/browser-relay";
import { browserUrl, chromiumUserAgent, handOver, issuedBy } from "../../src/main/browser/browser-tabs";
import { SandboxProxy } from "../../src/main/browser/sandbox-proxy";
import { sandboxDownloadsDir } from "../../src/main/store/project-dirs";
import { RelayClient } from "../../src/main/sbx/sbx-relay";
import { lineReader, parseRelayFrame, type RelayFrame } from "../../src/shared/browser-relay";
import { tempDir } from "../helpers";
import { CdpProxy, type CdpMessage } from "../../src/main/browser/cdp-proxy";
import type { BrowserPage } from "../../src/main/browser/browser-tabs";

/** browser/: what an address typed becomes, one tab's page as a whole browser over CDP, and a
 *  sandbox's tabs' way out through it. */

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

describe("chromiumUserAgent", () => {
  it("drops the app's token and Electron's, leaving Chromium's own", () => {
    const chromium = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36";
    assert.equal(
      chromiumUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tet-ide/43.4.0 Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36",
      ),
      chromium,
    );
    assert.equal(chromiumUserAgent(chromium), chromium, "one without them stays");
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

  it("lets go of the page the client detaches from, which is not gone", async () => {
    const { proxy, out, attached } = proxied();
    await proxy.handle({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } });
    await proxy.handle({ id: 2, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } });
    await proxy.handle({ id: 3, method: "Target.detachFromTarget", params: { sessionId: "tet-page-T1" } });
    const methods = out.map((message) => message.method).filter((method) => method !== undefined);
    assert.ok(methods.includes("Target.detachedFromTarget"));
    assert.ok(!methods.includes("Target.targetDestroyed"), "the page stays");
    assert.ok(!attached());
  });
});

/** A sandbox proxy's authority, valid for a century, and a site it signed for example.com. */
const SANDBOX_CA = [
  "-----BEGIN CERTIFICATE-----",
  "MIIB5jCCAYugAwIBAgIUAYSDUqhAoD94CBn3oPDt00h6CukwCgYIKoZIzj0EAwIw",
  "PzEZMBcGA1UECgwQRG9ja2VyIFNhbmRib3hlczEiMCAGA1UEAwwZRG9ja2VyIFNh",
  "bmRib3hlcyBQcm94eSBDQTAgFw0yNjEwMDgxODQ1MTdaGA8yMTI2MDkxNDE4NDUx",
  "N1owPzEZMBcGA1UECgwQRG9ja2VyIFNhbmRib3hlczEiMCAGA1UEAwwZRG9ja2Vy",
  "IFNhbmRib3hlcyBQcm94eSBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABI9Z",
  "c4S2zXP1MRm/mYxDslEuVHYIhOHlyDHMbfCJ7g6tAtXtMNhpN+Rf2104vbWucdOh",
  "kqbWGttTkkU9OOpHg2ijYzBhMB0GA1UdDgQWBBTunEtXCfbfwxU+4yDHLwEog6KR",
  "LjAfBgNVHSMEGDAWgBTunEtXCfbfwxU+4yDHLwEog6KRLjAPBgNVHRMBAf8EBTAD",
  "AQH/MA4GA1UdDwEB/wQEAwICBDAKBggqhkjOPQQDAgNJADBGAiEAy/8vNZv/gW+O",
  "v5HEvyVH4OlsqoiYAzp4Ql0PjbmFeNcCIQCViBLDLvYErMarY8RI3PU//vSmDVFF",
  "ki5oYJtrmd0Caw==",
  "-----END CERTIFICATE-----",
].join("\n");

const OTHER_CA = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBfDCCASOgAwIBAgIUa/CShP2Dmdd6pGkNbYIYKmIfincwCgYIKoZIzj0EAwIw",
  "EzERMA8GA1UEAwwIT3RoZXIgQ0EwIBcNMjYxMDA4MTg0NTE3WhgPMjEyNjA5MTQx",
  "ODQ1MTdaMBMxETAPBgNVBAMMCE90aGVyIENBMFkwEwYHKoZIzj0CAQYIKoZIzj0D",
  "AQcDQgAETgm/8SV04nDE0BwAdrvTr5LqgRXzoz/Hi9OunQ2yt8lkwcJ8ktFnISPr",
  "OkCZK5Dc3RFyhRWHBrhCR5X8tF8dTaNTMFEwHQYDVR0OBBYEFGSQHoUjJhNTeiul",
  "vPbMBmhc/2fJMB8GA1UdIwQYMBaAFGSQHoUjJhNTeiulvPbMBmhc/2fJMA8GA1Ud",
  "EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIfUipLf0lhYB3mClpep5TN7PXD",
  "q9y4ynO4AWLDUNliDAIhAPITB+5Lvj5uk1rzXsZzrhG3FFhe2WREqaPo7Rx8f4rI",
  "-----END CERTIFICATE-----",
].join("\n");

const SANDBOX_SITE = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBzjCCAXSgAwIBAgIUOxSbasmx7kOdJtkzzn7bJ/0ZrD8wCgYIKoZIzj0EAwIw",
  "PzEZMBcGA1UECgwQRG9ja2VyIFNhbmRib3hlczEiMCAGA1UEAwwZRG9ja2VyIFNh",
  "bmRib3hlcyBQcm94eSBDQTAgFw0yNjEwMDgxODQ1MTdaGA8yMTI2MDkxNDE4NDUx",
  "N1owMTEZMBcGA1UECgwQRG9ja2VyIFNhbmRib3hlczEUMBIGA1UEAwwLZXhhbXBs",
  "ZS5jb20wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATPGD9OHKDfyaFY5nxEH/m9",
  "77jFl8H7+7Bou5s6XGQkH+RAnqf7MN8b0JmVf1Vs5r/wDKmkg5uz40hNFqL/RM0p",
  "o1owWDAWBgNVHREEDzANggtleGFtcGxlLmNvbTAdBgNVHQ4EFgQULtploJ581ycV",
  "6Wk82ey9RyaZmW8wHwYDVR0jBBgwFoAU7pxLVwn238MVPuMgxy8BKIOikS4wCgYI",
  "KoZIzj0EAwIDSAAwRQIhAJNO3i1QATPKTpWJguSHGWRzPjK/zuxuSOaKMfKQ6b1u",
  "AiAsucaj3XhdEHvCN+8OmMGGE5++vdOP5EWu5r+vKnvE8A==",
  "-----END CERTIFICATE-----",
].join("\n");

/**
 * A sandbox's way out, end to end in this process: the proxy on the loopback (sandbox-proxy.ts),
 * the main process's end of the wire (RelayClient) and the relay as the sandbox runs it
 * (browser-relay.ts), joined by pipes where `sbx exec -i` would carry them.
 */
function sandboxRoute(env: NodeJS.ProcessEnv): { client: RelayClient; hello: Promise<RelayFrame> } {
  const toRelay = new PassThrough();
  const fromRelay = new PassThrough();
  serveRelay(toRelay, fromRelay, env);
  const client = new RelayClient((frame) => toRelay.write(`${JSON.stringify(frame)}\n`));
  const hello = new Promise<RelayFrame>((resolve) =>
    fromRelay.setEncoding("utf8").on(
      "data",
      lineReader((line) => {
        const frame = parseRelayFrame(line);
        if (frame?.op === "hello") {
          resolve(frame);
        } else if (frame) {
          client.receive(frame);
        }
      }),
    ),
  );
  return { client, hello };
}

/** A server on this process's loopback, closed after the test. */
async function listening(t: TestContext, server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as net.AddressInfo).port;
}

/** What a request through the proxy answers: its status and body. */
function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    http
      .get({ host: "127.0.0.1", port: proxyPort, path: url, headers: { Host: target.host } }, (answer) => {
        let body = "";
        answer.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
        answer.on("end", () => resolve({ status: answer.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

/** A tunnel through the proxy (CONNECT), and one plain HTTP request sent through it: what the
 *  CONNECT answered, and the request's answer when it was let through. */
function tunnel(proxyPort: number, authority: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority })
      .on("connect", (answer, socket) => {
        if (answer.statusCode !== 200) {
          socket.destroy();
          resolve({ status: answer.statusCode ?? 0, body: "" });
          return;
        }
        let body = "";
        socket.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
        socket.on("end", () => resolve({ status: 200, body: body.slice(body.indexOf("\r\n\r\n") + 4) }));
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
      })
      .on("error", reject)
      .end();
  });
}

/** A dev server in the sandbox: it answers with the path it was asked for. */
const devServer = (): http.Server => http.createServer((request, answer) => answer.end(`dev ${request.url ?? ""}`));

describe("the browser relay", () => {
  it("dials the sandbox's loopback and what NO_PROXY names directly, anything else through its proxy", () => {
    const noProxy = "gateway.docker.internal, .corp.example, *.internal.test, [::2]:8080";
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "0.0.0.0", "gateway.docker.internal"]) {
      assert.equal(bypassesProxy(host, noProxy), true, host);
    }
    for (const host of ["a.corp.example", "corp.example", "x.internal.test", "::2", "api.gateway.docker.internal"]) {
      assert.equal(bypassesProxy(host, noProxy), true, host);
    }
    for (const host of ["example.com", "host.docker.internal", "notcorp.example", "128.0.0.1"]) {
      assert.equal(bypassesProxy(host, noProxy), false, host);
    }
    assert.equal(bypassesProxy("example.com", "*"), true, "every host");
    assert.equal(proxyOf({ HTTPS_PROXY: "gateway.docker.internal:3128" })?.host, "gateway.docker.internal:3128");
    assert.equal(proxyOf({}), undefined);
  });

  it("hands over the certificate its sandbox's proxy signs with", async () => {
    const { hello } = sandboxRoute({ PROXY_CA_CERT_B64: Buffer.from(SANDBOX_CA).toString("base64") });
    assert.deepEqual(await hello, { op: "hello", ca: SANDBOX_CA });
    assert.deepEqual(await sandboxRoute({}).hello, { op: "hello" }, "none where the proxy intercepts none");
  });

  it("loads the sandbox's own dev server, over HTTP and through a tunnel, in origin form", async (t) => {
    const port = await listening(t, devServer());
    const { client } = sandboxRoute({ HTTPS_PROXY: "http://127.0.0.1:9" });
    const proxy = await SandboxProxy.start(client);
    t.after(() => proxy.close());
    assert.deepEqual(await viaProxy(proxy.port, `http://localhost:${port}/app?x=1`), { status: 200, body: "dev /app?x=1" });
    assert.deepEqual(await tunnel(proxy.port, `localhost:${port}`, "/ws"), { status: 200, body: "dev /ws" });
  });

  it("sends everything else through the sandbox's proxy, whose refusal stands and is said", async (t) => {
    const port = await listening(t, devServer());
    const asked: string[] = [];
    // The sandbox's proxy: example.com lets through to the dev server, blocked.test it refuses.
    const sandboxProxy = http.createServer((request, answer) => {
      asked.push(request.url ?? "");
      answer.end("from the proxy");
    });
    sandboxProxy.on("connect", (request: http.IncomingMessage, socket: net.Socket) => {
      asked.push(`CONNECT ${request.url ?? ""}`);
      if (request.url?.startsWith("blocked.test")) {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 47\r\n\r\nBlocked by network policy: domain blocked.test");
        return;
      }
      const upstream = net.connect(port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(upstream).pipe(socket);
      });
    });
    const proxyPort = await listening(t, sandboxProxy);
    const { client } = sandboxRoute({ HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "localhost" });
    const proxy = await SandboxProxy.start(client);
    t.after(() => proxy.close());

    assert.deepEqual(await tunnel(proxy.port, "example.com:443", "/secure"), { status: 200, body: "dev /secure" });
    assert.deepEqual(await viaProxy(proxy.port, "http://example.com/plain"), { status: 200, body: "from the proxy" });
    assert.deepEqual(asked, ["CONNECT example.com:443", "http://example.com/plain"], "in absolute form to the proxy");

    assert.equal((await tunnel(proxy.port, "blocked.test:443")).status, 502);
    assert.match(proxy.refusal("blocked.test") ?? "", /Blocked by network policy: domain blocked\.test/);
    assert.equal(proxy.refusal("example.com"), undefined);
  });

  it("refuses every dial once the relay is gone", async () => {
    const { client } = sandboxRoute({});
    client.end();
    await assert.rejects(client.open("localhost", 80, false), /the relay ended/);
  });
});

describe("handOver", () => {
  it("moves a sandbox's download into its downloads folder, numbered beside one already there", async () => {
    const root = tempDir("tet-download-");
    const saved = path.join(root, "app.zip");
    fs.writeFileSync(saved, "zip");
    const agentDir = path.join(root, "agent");
    const sandbox = { agentDir, downloadsDir: sandboxDownloadsDir(agentDir) };
    assert.equal(await handOver(saved, sandbox), path.join(agentDir, "downloads", "app.zip"));
    assert.equal(await handOver(saved, sandbox), path.join(agentDir, "downloads", "app (1).zip"));
    assert.equal(fs.readFileSync(path.join(agentDir, "downloads", "app (1).zip"), "utf8"), "zip");
  });

  it("writes nothing through a link the sandbox left in its folder", async (t) => {
    const root = tempDir("tet-download-");
    const saved = path.join(root, "app.zip");
    fs.writeFileSync(saved, "zip");
    const agentDir = path.join(root, "agent");
    const outside = path.join(root, "outside");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(agentDir, "downloads"), "junction");
    } catch {
      t.skip("no links here");
      return;
    }
    await assert.rejects(handOver(saved, { agentDir, downloadsDir: sandboxDownloadsDir(agentDir) }), /leads outside/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

describe("issuedBy", () => {
  const site = { data: SANDBOX_SITE } as Electron.Certificate;

  it("trusts a site the sandbox's proxy signed, for its host alone", () => {
    assert.equal(issuedBy(site, "example.com", SANDBOX_CA), true);
    assert.equal(issuedBy(site, "evil.test", SANDBOX_CA), false, "another host");
    assert.equal(issuedBy(site, "example.com", OTHER_CA), false, "another authority");
    assert.equal(issuedBy(site, "example.com", SANDBOX_SITE), false, "a site is no authority");
    assert.equal(issuedBy({ data: "nonsense" } as Electron.Certificate, "example.com", SANDBOX_CA), false);
  });
});
