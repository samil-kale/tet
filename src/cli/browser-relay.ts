import * as net from "node:net";
import type { Readable, Writable } from "node:stream";
import { errorMessage } from "../shared/errors";
import { isLoopbackHost } from "../shared/loopback";
import { lineReader, parseRelayFrame, RelayStreams, type RelayFrame } from "../shared/browser-relay";

/**
 * The browser relay: what a sandboxed agent's browser tab dials, dialled from inside its sandbox
 * (src/shared/browser-relay.ts holds the wire). TET writes it into the sandbox's agent folder and
 * runs it with the sandbox's node over `sbx exec -i` (sbx/sbx-relay.ts). A host the sandbox reaches
 * directly — its own loopback, its dev server there, and what its NO_PROXY names — is dialled
 * directly; anything else goes through the sandbox's proxy, as every process of the sandbox goes,
 * so its policy decides. Run by tet-browser-relay.ts; no electron.
 */

/** How much of a proxy's refusal is kept: its policy's explanation, not a page. */
const MAX_REFUSAL_CHARS = 2000;

/** How long a refusal's body is waited for once its head arrived. */
const REFUSAL_WAIT_MS = 2000;

/** The sandbox's proxy, as its processes read it; undefined where it has none. */
export function proxyOf(env: NodeJS.ProcessEnv): URL | undefined {
  const value = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (!value) {
    return undefined;
  }
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return undefined;
  }
}

/** Whether `host` is dialled directly rather than through the proxy: the sandbox's own loopback,
 *  and what its NO_PROXY names — a host and its subdomains (`domain`, `.domain`, `*.domain`), or
 *  `*` for every one, as curl reads it. */
export function bypassesProxy(host: string, noProxy: string | undefined): boolean {
  if (isLoopbackHost(host)) {
    return true;
  }
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (noProxy ?? "")
    .split(",")
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/^\[([^\]]*)\](:\d+)?$/, "$1")
        .replace(/^([^:]*):\d+$/, "$1"),
    )
    .filter((entry) => entry !== "")
    .some((entry) => {
      if (entry === "*") {
        return true;
      }
      const domain = entry.replace(/^\*?\./, "");
      return name === domain || name.endsWith(`.${domain}`);
    });
}

/** A socket whose error ends it without ending the relay, until RelayStreams carries it: its close
 *  says so. */
function quiet(socket: net.Socket): net.Socket {
  return socket.on("error", () => undefined);
}

/** A socket connected to `host:port`, quiet (see quiet); rejects with why it is not, the socket
 *  destroyed. */
function connect(host: string, port: number): Promise<net.Socket> {
  const socket = quiet(net.connect({ host, port }));
  return new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
    const onError = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
  });
}

/** The proxy's answer to a CONNECT: its head, and what followed it already. */
function readHead(socket: net.Socket): Promise<{ status: number; head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let held = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      held = Buffer.concat([held, chunk]);
      const end = held.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      socket.off("data", onData);
      socket.off("error", reject);
      socket.off("end", onEnd);
      socket.pause();
      const head = held.subarray(0, end).toString("latin1");
      resolve({ status: Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head)?.[1] ?? 0), head, rest: held.subarray(end + 4) });
    };
    const onEnd = (): void => reject(new Error("the proxy closed the connection"));
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("end", onEnd);
  });
}

/** A refusal's body, as much as arrives in REFUSAL_WAIT_MS, cut to MAX_REFUSAL_CHARS. */
function readRefusal(socket: net.Socket, rest: Buffer): Promise<string> {
  return new Promise((resolve) => {
    let body = rest;
    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(body.toString("utf8").trim().slice(0, MAX_REFUSAL_CHARS));
    };
    const timer = setTimeout(done, REFUSAL_WAIT_MS);
    socket.on("data", (chunk: Buffer) => {
      body = Buffer.concat([body, chunk]);
      if (body.length >= MAX_REFUSAL_CHARS) {
        done();
      }
    });
    socket.once("end", done);
    socket.once("error", done);
    socket.resume();
  });
}

type Dialled = { socket: net.Socket; proxied: boolean } | { message: string };

/** `host:port` dialled as the sandbox dials it (see the file's comment), through `proxy` unless
 *  `noProxy` names the host. */
async function dial(host: string, port: number, http: boolean, proxy: URL | undefined, noProxy: string | undefined): Promise<Dialled> {
  const target = host.replace(/^\[|\]$/g, "");
  if (!proxy || bypassesProxy(host, noProxy)) {
    try {
      return { socket: await connect(target, port), proxied: false };
    } catch (error) {
      return { message: errorMessage(error) };
    }
  }
  let socket: net.Socket;
  try {
    socket = await connect(proxy.hostname.replace(/^\[|\]$/g, ""), Number(proxy.port || 80));
  } catch (error) {
    return { message: `the sandbox's proxy: ${errorMessage(error)}` };
  }
  // Plain HTTP is the proxy's to read (RelayFrame's `http`); a login in the proxy's address is
  // only sent on a tunnel's CONNECT, which the sandbox's proxies need none for.
  if (http) {
    return { socket, proxied: true };
  }
  const login = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
    : "";
  const authority = target.includes(":") ? `[${target}]:${port}` : `${target}:${port}`;
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${login}\r\n`);
  let answer: Awaited<ReturnType<typeof readHead>>;
  try {
    answer = await readHead(socket);
  } catch (error) {
    socket.destroy();
    return { message: `the sandbox's proxy: ${errorMessage(error)}` };
  }
  if (answer.status !== 200) {
    const body = await readRefusal(socket, answer.rest);
    return { message: body || answer.head.split("\r\n")[0] };
  }
  if (answer.rest.length > 0) {
    socket.unshift(answer.rest);
  }
  return { socket, proxied: false };
}

/**
 * Serves the wire on `input` and `output` until `input` ends: hello first, then each `open` dialled
 * and its stream carried.
 */
export function serveRelay(input: Readable, output: Writable, env: NodeJS.ProcessEnv): void {
  const send = (frame: RelayFrame): boolean => output.write(`${JSON.stringify(frame)}\n`);
  const streams = new RelayStreams(send);
  output.on("drain", () => streams.drained());
  // Sent as the proxy's own variable carries it: base64 of the PEM.
  const proxy = proxyOf(env);
  const noProxy = env.no_proxy ?? env.NO_PROXY;
  const ca = env.PROXY_CA_CERT_B64 ? Buffer.from(env.PROXY_CA_CERT_B64, "base64").toString("utf8") : undefined;
  send(ca ? { op: "hello", ca } : { op: "hello" });
  /** Opened and not dialled yet, by id: true once the main process closed it meanwhile. */
  const dialling = new Map<number, boolean>();
  input.setEncoding("utf8");
  input.on(
    "data",
    lineReader((line) => {
      const frame = parseRelayFrame(line);
      if (frame?.op === "close" && dialling.has(frame.id)) {
        dialling.set(frame.id, true);
        return;
      }
      if (frame?.op !== "open") {
        if (frame) {
          streams.receive(frame);
        }
        return;
      }
      const { id } = frame;
      dialling.set(id, false);
      void dial(frame.host, frame.port, frame.http === true, proxy, noProxy).then((dialled) => {
        const closed = dialling.get(id) === true;
        dialling.delete(id);
        if (closed) {
          if ("socket" in dialled) {
            dialled.socket.destroy();
          }
        } else if ("socket" in dialled) {
          send({ op: "opened", id, proxied: dialled.proxied });
          streams.attach(id, dialled.socket);
        } else {
          send({ op: "refused", id, message: dialled.message });
        }
      });
    }),
  );
  input.on("end", () => streams.closeAll());
}
