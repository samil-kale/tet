import * as http from "node:http";
import type * as net from "node:net";
import type { Duplex } from "node:stream";
import { errorMessage } from "../../shared/errors";

/** Dials from inside a sandbox (sbx/sbx-relay.ts's SandboxRelay): rejects with why it would not. */
export interface SandboxDialer {
  open(host: string, port: number, http: boolean): Promise<{ stream: Duplex; proxied: boolean }>;
}

/** Hop-by-hop headers, the proxy's own to answer, never forwarded: each side keeps its own
 *  connection. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "upgrade"]);

/** `rawHeaders` without the hop-by-hop ones. */
function endToEnd(raw: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (!HOP_HEADERS.has(raw[index].toLowerCase())) {
      kept.push(raw[index], raw[index + 1]);
    }
  }
  return kept;
}

/** A tunnel's answer, written on its socket as no `ServerResponse` writes one: `message` as plain
 *  text, the connection closed. */
function tunnelAnswer(status: string, message = ""): string {
  const body = Buffer.from(message);
  return `HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${message}`;
}

/**
 * The proxy a sandboxed agent's browser tabs load through (browser-tabs.ts's sandbox profile): an
 * HTTP proxy on this machine's loopback whose every connection is dialled from inside the sandbox
 * (SandboxDialer). A tunnel (CONNECT: HTTPS, WebSockets) is carried as it is; a plain HTTP request
 * is sent on, in its absolute form where it reaches the sandbox's own proxy. Nothing is dialled
 * from this machine, so a page sees what the sandbox sees and its policy holds.
 *
 * Unauthenticated, on the loopback: whatever runs on this machine already reaches the sandbox, and
 * through it nothing beyond what the sandbox may.
 */
export class SandboxProxy {
  /** Why a host was last refused, for the page's failure (browser-tabs.ts). */
  private readonly refused = new Map<string, string>();

  private constructor(
    private readonly server: http.Server,
    private readonly dialer: SandboxDialer,
    readonly port: number,
  ) {}

  static start(dialer: SandboxDialer): Promise<SandboxProxy> {
    const server = http.createServer();
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const proxy = new SandboxProxy(server, dialer, (server.address() as net.AddressInfo).port);
        server.on("connect", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => proxy.tunnel(request, socket, head));
        server.on("request", (request: http.IncomingMessage, response: http.ServerResponse) => proxy.forward(request, response));
        resolve(proxy);
      });
    });
  }

  /** Why `host` was last refused, if it was. */
  refusal(host: string): string | undefined {
    return this.refused.get(host.toLowerCase());
  }

  close(): void {
    this.server.close();
    this.server.closeAllConnections();
  }

  private refuse(host: string, error: unknown): string {
    const message = errorMessage(error);
    this.refused.set(host.toLowerCase(), message);
    return message;
  }

  /** `host` reached: its last refusal no longer stands. */
  private accept(host: string): void {
    this.refused.delete(host.toLowerCase());
  }

  private tunnel(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => undefined);
    const target = URL.parse(`http://${request.url ?? ""}`);
    if (!target) {
      socket.end(tunnelAnswer("400 Bad Request"));
      return;
    }
    this.dialer.open(target.hostname, Number(target.port || 443), false).then(
      ({ stream }) => {
        if (socket.destroyed) {
          stream.destroy();
          return;
        }
        this.accept(target.hostname);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          stream.write(head);
        }
        stream.on("error", () => socket.destroy());
        socket.on("close", () => stream.destroy());
        stream.on("close", () => socket.destroy());
        socket.pipe(stream).pipe(socket);
      },
      (error: unknown) => socket.end(tunnelAnswer("502 Bad Gateway", this.refuse(target.hostname, error))),
    );
  }

  private forward(request: http.IncomingMessage, response: http.ServerResponse): void {
    const fail = (message: string): void => {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" }).end(message);
      }
    };
    const target = URL.parse(request.url ?? "");
    if (target?.protocol !== "http:") {
      response.writeHead(400, { Connection: "close" }).end();
      return;
    }
    this.dialer.open(target.hostname, Number(target.port || 80), true).then(
      ({ stream, proxied }) => {
        this.accept(target.hostname);
        // One request per connection to the sandbox: the next may be for another host.
        const sent = http.request({
          createConnection: () => stream,
          method: request.method,
          path: proxied ? target.href : `${target.pathname}${target.search}`,
          headers: [...endToEnd(request.rawHeaders), "Connection", "close"],
          setHost: false,
        });
        sent.on("response", (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.statusMessage, endToEnd(answer.rawHeaders));
          answer.pipe(response);
        });
        sent.on("error", (error) => fail(error.message));
        response.on("close", () => sent.destroy());
        request.pipe(sent);
      },
      (error: unknown) => fail(this.refuse(target.hostname, error)),
    );
  }
}
