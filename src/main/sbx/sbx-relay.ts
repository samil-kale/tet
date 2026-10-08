import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { duplexPair, type Duplex } from "node:stream";
import { lineReader, parseRelayFrame, RelayStreams, type RelayFrame } from "../../shared/browser-relay";
import { killProcessTree, resolveCommand } from "../util/process";
import { sbxError, sbxFailure, writeIntoSandbox } from "./sbx-cli";

/** What the relay dialled: the stream, and whether it reaches the sandbox's proxy (RelayFrame). */
export interface RelayDialled {
  stream: Duplex;
  proxied: boolean;
}

/** How long a dial is waited for: sbx's proxy answers a refused host at once. */
const DIAL_TIMEOUT_MS = 30_000;

/** How much of what the relay or sbx said on stderr is kept, from its end, for why it ended. */
const MAX_STDERR = 2000;

/** Where the relay lies in the sandbox's own filesystem, never a mount: a file TET wrote into a
 *  folder the sandbox writes too could be a link to one of this machine's. */
const RELAY_FILE = "~/.local/share/tet/browser-relay.js";

/**
 * The main process's end of the relay's wire (src/shared/browser-relay.ts), whatever carries it:
 * the dials it opens and the connections they became. `send` answers false while the pipe is full.
 */
export class RelayClient {
  private readonly dials = new Map<number, (frame: RelayFrame) => void>();
  private readonly streams: RelayStreams;
  private opened = 0;
  private gone = false;

  constructor(private readonly send: (frame: RelayFrame) => boolean) {
    this.streams = new RelayStreams(send);
  }

  /** `host:port` dialled from inside the sandbox; rejects with why the sandbox would not (its
   *  proxy's refusal). */
  async open(host: string, port: number, http: boolean): Promise<RelayDialled> {
    if (this.gone) {
      throw new Error("the relay ended");
    }
    const id = ++this.opened;
    const answer = await new Promise<RelayFrame>((resolve) => {
      const timer = setTimeout(() => {
        this.dials.delete(id);
        this.send({ op: "close", id });
        resolve({ op: "refused", id, message: `no answer from the sandbox within ${DIAL_TIMEOUT_MS / 1000} s` });
      }, DIAL_TIMEOUT_MS);
      this.dials.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      this.send(http ? { op: "open", id, host, port, http: true } : { op: "open", id, host, port });
    });
    if (answer.op !== "opened") {
      throw new Error(answer.op === "refused" ? answer.message : "the relay ended");
    }
    // One end for the caller, the other carried by the relay.
    const [mine, carried] = duplexPair();
    this.streams.attach(id, carried);
    return { stream: mine, proxied: answer.proxied };
  }

  /** A frame from the relay; its hello is the carrier's. */
  receive(frame: RelayFrame): void {
    if (frame.op === "opened" || frame.op === "refused") {
      const answer = this.dials.get(frame.id);
      this.dials.delete(frame.id);
      if (answer) {
        answer(frame);
      } else if (frame.op === "opened") {
        // Given up on (DIAL_TIMEOUT_MS): the relay lets go of it.
        this.send({ op: "close", id: frame.id });
      }
    } else if (frame.op !== "hello") {
      this.streams.receive(frame);
    }
  }

  /** The pipe takes frames again. */
  drained(): void {
    this.streams.drained();
  }

  /** The relay is gone: every dial waiting and every connection open with it. */
  end(): void {
    this.gone = true;
    for (const [id, answer] of this.dials) {
      answer({ op: "close", id });
    }
    this.dials.clear();
    this.streams.closeAll();
  }
}

/**
 * A sandbox's browser relay (src/cli/browser-relay.ts), as seen from the main process: run with
 * the sandbox's node over `sbx exec -i`, started by the first dial and again by the first after it
 * ended — a sandbox stopped or rebuilt meanwhile ends it. `bundle`, the relay's own build, is written
 * into the sandbox's own filesystem first (writeIntoSandbox), as sbx.ts's ensureSandboxLauncher
 * writes `tet-ctl`.
 */
export class SandboxRelay {
  private child: ChildProcess | undefined;
  private client: RelayClient | undefined;
  private started: Promise<{ ca?: string }> | undefined;

  constructor(
    private readonly name: string,
    private readonly bundle: string,
  ) {}

  /** Started, and its proxy's certificate (RelayFrame's hello); rejects with why it would not
   *  start. */
  hello(): Promise<{ ca?: string }> {
    this.started ??= this.start().catch((error: unknown) => {
      this.started = undefined;
      throw error;
    });
    return this.started;
  }

  /** `host:port` dialled from inside the sandbox, the relay started first; rejects as
   *  RelayClient.open does, or with why it would not start. */
  async open(host: string, port: number, http: boolean): Promise<RelayDialled> {
    await this.hello();
    if (!this.client) {
      throw new Error(`the browser relay of ${this.name} ended`);
    }
    return this.client.open(host, port, http);
  }

  /** Ends the relay and every connection through it. */
  stop(): void {
    const { child, client } = this;
    this.child = undefined;
    this.client = undefined;
    this.started = undefined;
    if (child) {
      child.stdin?.end();
      killProcessTree(child);
    }
    client?.end();
  }

  private async start(): Promise<{ ca?: string }> {
    const written = await writeIntoSandbox(this.name, RELAY_FILE, await fs.promises.readFile(this.bundle, "utf8"));
    if (!written.ok) {
      throw new Error(`could not start the browser relay in ${this.name}: ${sbxFailure(written, "writing the browser relay")}`);
    }
    const resolved = resolveCommand("sbx", ["exec", "-i", this.name, "sh", "-c", `exec node ${RELAY_FILE}`]);
    const child = spawn(resolved.command, resolved.args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new RelayClient((frame) => (child.stdin.writable ? child.stdin.write(`${JSON.stringify(frame)}\n`) : true));
    this.child = child;
    this.client = client;
    let stderr = "";
    return new Promise((resolve, reject) => {
      child.stdout.setEncoding("utf8").on(
        "data",
        lineReader((line) => {
          const frame = parseRelayFrame(line);
          if (frame?.op === "hello") {
            resolve({ ca: frame.ca });
          } else if (frame) {
            client.receive(frame);
          }
        }),
      );
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_STDERR);
      });
      child.stdin.on("drain", () => client.drained());
      // The relay gone first fails the write (EPIPE); its exit says so.
      child.stdin.on("error", () => undefined);
      child.once("error", (error) => reject(error));
      child.once("close", (code) => {
        const ended = { ok: false, code, stdout: "", stderr };
        reject(new Error(`the browser relay of ${this.name} ended: ${sbxError(ended) || `exit ${code ?? "none"}`}`));
        client.end();
        if (this.child === child) {
          sbxFailure(ended, `the browser relay of ${this.name}`);
          this.child = undefined;
          this.client = undefined;
          this.started = undefined;
        }
      });
    });
  }
}
