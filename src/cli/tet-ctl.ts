import * as http from "node:http";
import { CONTROL_ENV, CONTROL_VERBS, EXIT_CODES, HELP_VERB } from "../shared/control";
import type { ControlRequest, ControlResponse } from "../shared/control";

/**
 * `tet-ctl`: the command an agent runs inside one of tet's terminals to ask the app around
 * it something. A plain script with no electron in it, bundled on its own (see esbuild.js) and
 * started by the launcher in userData/bin under tet's own electron as node — the terminal's
 * environment tells it where tet listens and who it is (see src/shared/control.ts).
 *
 * Output is for an agent, not a person: the result as JSON on stdout, one line of plain text
 * on stderr when something went wrong, and an exit code it can branch on.
 */

function usage(): string {
  const width = Math.max(...CONTROL_VERBS.map((entry) => entry.usage.length));
  return [
    "tet-ctl — control the TET app this terminal runs in",
    "",
    ...CONTROL_VERBS.map((entry) => `  ${entry.usage.padEnd(width)}  ${entry.summary}`),
    "",
    "Without --project, a verb acts on the project of the tab it is run from."
  ].join("\n");
}

function fail(message: string, code: number): never {
  process.stderr.write(`tet-ctl: ${message}\n`);
  process.exit(code);
}

/** `verb [positionals...] [--project <id>] [--agent <id>] [--confirm]` into a request's verb and args. */
function parse(argv: string[]): { verb: string; args: Record<string, unknown> } {
  const [verb, ...rest] = argv;
  if (!verb || verb === HELP_VERB || verb === "--help" || verb === "-h") {
    return { verb: HELP_VERB, args: {} };
  }
  const entry = CONTROL_VERBS.find((candidate) => candidate.verb === verb);
  if (!entry) {
    fail(`unknown verb: ${verb}\n\n${usage()}`, EXIT_CODES.usage);
  }
  const args: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--confirm") {
      args.confirm = true;
    } else if (arg === "--project" || arg === "--agent") {
      const value = rest[i + 1];
      if (value === undefined) {
        fail(`${arg} needs a value`, EXIT_CODES.usage);
      }
      args[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      fail(`unknown option: ${arg}`, EXIT_CODES.usage);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > entry.positionals.length) {
    fail(`too many arguments\n\n  ${entry.usage}`, EXIT_CODES.usage);
  }
  entry.positionals.forEach((name, index) => {
    if (positionals[index] !== undefined) {
      args[name] = positionals[index];
    }
  });
  return { verb, args };
}

/**
 * HTTP rather than a raw socket — the one transport that reaches the server both from a plain
 * host terminal and from inside an sbx sandbox. sbx's own docs (docker/docs' sandboxes/workflows/
 * development.md, read live 2026-09-08): a sandbox reaches `host.docker.internal` through sbx's
 * own proxy, and that proxy is HTTP-only — a raw TCP echo server behind it accepted the connect
 * but never saw a byte of what was written, verified live against a real sandbox, while a plain
 * `curl http://host.docker.internal:<port>` reached the same host process immediately. One
 * request per connection either way (`Connection: close`), matching the server's own model.
 */
function send(host: string, port: number, request: ControlRequest): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const req = http.request(
      {
        host,
        port,
        method: "POST",
        path: "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "close" }
      },
      (res) => {
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
        });
        res.on("end", () => {
          const answer = buffer.trim();
          if (!answer) {
            reject(new Error("TET closed the connection without answering"));
            return;
          }
          try {
            resolve(JSON.parse(answer) as ControlResponse);
          } catch {
            reject(new Error(`not an answer: ${answer}`));
          }
        });
      }
    );
    req.once("error", reject);
    req.end(body);
  });
}

/**
 * How long a port nobody answers on is tried again before it counts as absent. The server comes
 * up with the workspace (see main.ts's startControl), a moment after the terminal this runs in
 * did — and after `restart-app`, the new tet is that same moment away.
 */
const CONNECT_RETRY_MS = 5000;
const CONNECT_RETRY_GAP_MS = 250;

/** `send`, retried while nothing listens yet; any other failure is answered at once. */
async function sendWhenUp(host: string, port: number, request: ControlRequest): Promise<ControlResponse> {
  const deadline = Date.now() + CONNECT_RETRY_MS;
  for (;;) {
    try {
      return await send(host, port, request);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ECONNREFUSED" || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_GAP_MS));
    }
  }
}

async function main(): Promise<void> {
  const { verb, args } = parse(process.argv.slice(2));
  if (verb === HELP_VERB) {
    process.stdout.write(usage() + "\n");
    return;
  }
  const portVar = process.env[CONTROL_ENV.port];
  const token = process.env[CONTROL_ENV.token];
  if (!portVar || !token) {
    fail("not inside a TET terminal (TET_CONTROL_PORT is not set)", EXIT_CODES.internal);
  }
  const request: ControlRequest = {
    token,
    verb,
    args,
    caller: { projectId: process.env[CONTROL_ENV.projectId], tabId: process.env[CONTROL_ENV.tabId] }
  };
  let response: ControlResponse;
  try {
    response = await sendWhenUp(process.env[CONTROL_ENV.host] || "127.0.0.1", Number(portVar), request);
  } catch (error) {
    fail(`could not reach TET: ${error instanceof Error ? error.message : String(error)}`, EXIT_CODES.internal);
  }
  if (!response.ok) {
    const { code, message } = response.error;
    fail(
      message,
      code === "unauthorized" ? EXIT_CODES.unauthorized : code === "internal" ? EXIT_CODES.internal : EXIT_CODES.usage
    );
  }
  process.stdout.write(JSON.stringify(response.result, null, 2) + "\n");
}

void main();
