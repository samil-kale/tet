import type { Duplex } from "node:stream";

/**
 * The browser relay's wire, between the main process (sbx/sbx-relay.ts) and the relay it runs in a
 * sandbox (src/cli/browser-relay.ts) over `sbx exec -i`'s stdin and stdout: one JSON frame per
 * line, a stream's bytes in base64, so nothing on the way can bend them. Many connections share it,
 * each by its id, opened by the main process alone.
 */
export type RelayFrame =
  /** The relay's first line: the certificate its sandbox's proxy signs every HTTPS site with, PEM,
   *  absent where it intercepts none. */
  | { op: "hello"; ca?: string }
  /** Dial `host:port` as the sandbox would. `http`: for plain HTTP, which goes to the sandbox's
   *  proxy itself rather than through a tunnel, since that proxy reads the request. */
  | { op: "open"; id: number; host: string; port: number; http?: true }
  /** Dialled. `proxied`: the stream reaches the sandbox's proxy, not the host, so a request takes
   *  its absolute form. */
  | { op: "opened"; id: number; proxied: boolean }
  /** Not dialled: the proxy's status and words (its policy's refusal), else the dial's error. */
  | { op: "refused"; id: number; status?: number; message: string }
  | { op: "data"; id: number; data: string }
  /** The sender's side ended: no more data from it. */
  | { op: "end"; id: number }
  /** The connection is gone, both ways. */
  | { op: "close"; id: number };

/** One frame from a line, undefined for one that is none (a stray line on the way). */
export function parseRelayFrame(line: string): RelayFrame | undefined {
  try {
    const frame = JSON.parse(line) as RelayFrame | null;
    return typeof frame === "object" && frame !== null && typeof frame.op === "string" ? frame : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a text stream into lines as it arrives, the last one held until it ends. */
export function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let held = "";
  return (chunk) => {
    const lines = (held + chunk).split("\n");
    held = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() !== "") {
        onLine(line);
      }
    }
  };
}

/**
 * The connections sharing one relay, by id, on either end: what a connection reads is sent as
 * frames, what frames carry is written to it. `send` answers false while the pipe is full: every
 * connection then pauses until `drained`.
 */
export class RelayStreams {
  private readonly streams = new Map<number, Duplex>();
  private paused = false;

  constructor(private readonly send: (frame: RelayFrame) => boolean) {}

  /** The stream carried as `id`, made to flow (a paused one too) unless the pipe is full; anything
   *  it holds already is sent first. */
  attach(id: number, stream: Duplex): void {
    this.streams.set(id, stream);
    stream.on("data", (chunk: Buffer) => {
      if (!this.send({ op: "data", id, data: chunk.toString("base64") }) && !this.paused) {
        this.paused = true;
        this.streams.forEach((each) => each.pause());
      }
    });
    stream.on("end", () => {
      if (this.streams.has(id)) {
        this.send({ op: "end", id });
      }
    });
    stream.on("close", () => {
      if (this.streams.get(id) === stream) {
        this.streams.delete(id);
        this.send({ op: "close", id });
      }
    });
    // Its close follows, which says so.
    stream.on("error", () => undefined);
    if (this.paused) {
      stream.pause();
    } else {
      stream.resume();
    }
  }

  /** A data, end or close frame for one of them; one already gone takes nothing. */
  receive(frame: RelayFrame): void {
    if (frame.op !== "data" && frame.op !== "end" && frame.op !== "close") {
      return;
    }
    const stream = this.streams.get(frame.id);
    if (!stream) {
      return;
    }
    if (frame.op === "data") {
      stream.write(Buffer.from(frame.data, "base64"));
    } else if (frame.op === "end") {
      stream.end();
    } else {
      this.streams.delete(frame.id);
      stream.destroy();
    }
  }

  /** The pipe takes frames again. */
  drained(): void {
    if (this.paused) {
      this.paused = false;
      this.streams.forEach((each) => each.resume());
    }
  }

  /** The relay is gone: every connection with it. */
  closeAll(): void {
    const streams = [...this.streams.values()];
    this.streams.clear();
    streams.forEach((stream) => stream.destroy());
  }
}
