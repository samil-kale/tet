import * as http from "node:http";
import { errorMessage } from "../shared/errors";
import { CONTROL_ENV, CONTROL_FLAGS, CONTROL_GROUPS, CONTROL_VERBS, EXIT_CODES, HELP_VERB } from "../shared/control";
import type { ControlRequest, ControlResponse, ControlVerb } from "../shared/control";

/**
 * `tet-ctl`: how an agent in a tet terminal asks the app. No electron; bundled on its own
 * (esbuild.js), started by the launcher in ~/.tet/bin; the environment says where tet listens and
 * who the caller is (src/shared/control.ts). Output is for an agent: JSON on stdout, one line on
 * stderr on failure, and an exit code to branch on.
 */

/** When tet-ctl is the right tool at all. systemPrompt's one line sends an agent here, so this
 *  sits beside the verbs: nothing installed into an agent's configuration, and all four read it
 *  alike. It does not repeat that prompt. */
function whenToUse(sandboxed: boolean): string[] {
  return [
    "This terminal is one tab of one project in TET; other tabs run other agents, shells and saved",
    "commands, and the user watches them all. Reach for tet-ctl when the user asks about TET itself,",
    "means something they ran or saw in another tab (\"the error in the shell\", \"what did codex",
    "say\"), wants something put in front of them rather than in your answer, or when another agent",
    // A sandboxed tab is not offered tabs-run-command, so it is not sent looking for one.
    sandboxed ? "should do the job." : "or a saved command should do the job.",
    "",
    "Leave it alone for files and git: read the repository and run git yourself.",
    // Never offered in a sandbox (ControlVerb.sandbox absent), so not mentioned there either.
    ...(sandboxed
      ? []
      : [
          "",
          "A token or password you need is an environment variable ($GITLAB_TOKEN). TET sets the ones",
          "it keeps (env-list) in every tab it starts, over the machine's own. When one is missing,",
          "never ask for its value in the chat: ask the user which way they want, naming every missing",
          "variable at once —",
          "  1. in TET: env-request NAME [NAME...] opens TET's dialog; they type the values there, TET",
          "     keeps them encrypted, and this tab sees them once restarted, which the dialog offers.",
          "  2. themselves: setx (Windows) or their shell profile; TET itself must then be restarted,",
          "     since it hands its tabs the environment it was started with — and a value TET keeps",
          "     under the same name still wins.",
          "env-request waits for the user: run it with your longest command timeout (10 minutes), or",
          "its dialog closes when your shell gives up on it."
        ])
  ];
}

/** Set on sbx sessions alone (sbx.ts hands it in as the host to reach), so the CLI knows where it
 *  runs without asking: a sandboxed agent is listed only the verbs the server answers it, instead
 *  of meeting the refusal one verb at a time. */
function inSandbox(): boolean {
  return Boolean(process.env[CONTROL_ENV.host]);
}

/** The rules the verb list does not carry, each side told only its own: a sandbox is no concern of
 *  a tab on the host, which cannot end up in one. */
function limits(sandboxed: boolean): string[] {
  const own = "Without --project, a verb acts on the project of the tab it is run from.";
  return sandboxed
    ? [
        own,
        "This tab runs in an sbx sandbox: what acts on the host machine — its settings and projects,",
        "restarting TET, starting or typing into a tab — is refused there and is not listed above.",
        "What is listed answers for this project's tabs only (exit 2, the reason on stderr)."
      ]
    : [
        `${own} restartRequired in an`,
        "answer means the change waits for a restart — tell the user, never restart for them.",
        "A terminal of another project is refused, exit 2 with the reason on stderr (tabs-output,",
        "tabs-send)."
      ];
}

/** Each verb's summary on its own indented line: padding every usage to the longest (tabs-wait)
 *  would cost an agent some 140 spaces a line. */
function usage(): string {
  const sandboxed = inSandbox();
  // `sandbox` absent is refused there (ControlVerb.sandbox), which is what leaves a verb out.
  const listed = (entry: ControlVerb): boolean => !entry.unlisted && (!sandboxed || entry.sandbox !== undefined);
  const groups = CONTROL_GROUPS.map((heading) => ({
    heading,
    lines: CONTROL_VERBS.filter((entry) => entry.group === heading && listed(entry)).flatMap((entry) => [
      `  ${entry.usage}`,
      `      ${entry.summary}`
    ])
  })).filter((group) => group.lines.length > 0);
  return [
    "tet-ctl — control the TET app this terminal runs in",
    "",
    ...whenToUse(sandboxed),
    ...groups.flatMap((group) => ["", group.heading, ...group.lines]),
    "",
    ...limits(sandboxed)
  ].join("\n");
}

function fail(message: string, code: number): never {
  process.stderr.write(`tet-ctl: ${message}\n`);
  process.exit(code);
}

/** `verb [positionals...] [--<flag> [value]...]` — see CONTROL_FLAGS. */
function parse(argv: string[]): { verb: string; args: Record<string, unknown>; entry?: ControlVerb } {
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
    const flag = arg.startsWith("--") ? CONTROL_FLAGS[arg.slice(2)] : undefined;
    if (flag === "switch") {
      args[arg.slice(2)] = true;
    } else if (flag === "value") {
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
  if (positionals.length > entry.positionals.length && !entry.variadic) {
    fail(`too many arguments\n\n  ${entry.usage}`, EXIT_CODES.usage);
  }
  entry.positionals.forEach((name, index) => {
    if (entry.variadic && index === entry.positionals.length - 1) {
      args[name] = positionals.slice(index);
    } else if (positionals[index] !== undefined) {
      args[name] = positionals[index];
    }
  });
  return { verb, args, entry };
}

/** HTTP, one request per connection — why is at `startControlServer` (control-server.ts).
 *  `idleMs` gives up on a silent connection. */
function send(host: string, port: number, request: ControlRequest, idleMs?: number): Promise<ControlResponse> {
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
        // A drop mid-answer errors here and would throw unheard; a hook must end quietly.
        res.on("error", reject);
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
    req.on("error", reject);
    if (idleMs !== undefined) {
      req.setTimeout(idleMs, () => req.destroy(new Error(`TET did not answer within ${idleMs / 1000} s`)));
    }
    req.end(body);
  });
}

/**
 * A hook's wait on a stalled app: the agent's turn waits on its hook, which must not hold it for
 * good. Given up on, it answers nothing.
 */
const HOOK_IDLE_MS = 10_000;

/** The server comes up with the workspace, after the terminal may (and after `restart-app`). */
const CONNECT_RETRY_MS = 5000;
const CONNECT_RETRY_GAP_MS = 250;

/** Retries only while nothing listens yet. */
async function sendWhenUp(host: string, port: number, request: ControlRequest, idleMs?: number): Promise<ControlResponse> {
  const deadline = Date.now() + CONNECT_RETRY_MS;
  for (;;) {
    try {
      return await send(host, port, request, idleMs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ECONNREFUSED" || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_GAP_MS));
    }
  }
}

/** A hook pipes its JSON and closes stdin; a TTY (run by hand) would block forever. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const { verb, args, entry } = parse(process.argv.slice(2));
  if (verb === HELP_VERB) {
    process.stdout.write(usage() + "\n");
    return;
  }
  // A hook never fails and prints nothing of its own: Claude Code appends UserPromptSubmit's stdout
  // to the prompt and can hold it back on failure; Codex parses its Stop hook's stdout as JSON.
  const quiet = entry?.stdout === true;
  if (entry?.stdin) {
    args.payload = await readStdin();
  }
  const portVar = process.env[CONTROL_ENV.port];
  const token = process.env[CONTROL_ENV.token];
  if (!portVar || !token) {
    if (quiet) {
      return;
    }
    fail("not inside a TET terminal (TET_CONTROL_PORT is not set)", EXIT_CODES.internal);
  }
  const request: ControlRequest = {
    token,
    verb,
    args,
    caller: { projectId: process.env[CONTROL_ENV.projectId], tabId: process.env[CONTROL_ENV.tabId] },
    // Started when the hook fired, which orders turn signals.
    at: Date.now()
  };
  let response: ControlResponse;
  try {
    response = await sendWhenUp(
      process.env[CONTROL_ENV.host] || "127.0.0.1",
      Number(portVar),
      request,
      quiet ? HOOK_IDLE_MS : undefined
    );
  } catch (error) {
    if (quiet) {
      return;
    }
    fail(`could not reach TET: ${errorMessage(error)}`, EXIT_CODES.internal);
  }
  if (!response.ok) {
    if (quiet) {
      return;
    }
    const { code, message } = response.error;
    fail(
      message,
      code === "unauthorized"
        ? EXIT_CODES.unauthorized
        : code === "internal"
          ? EXIT_CODES.internal
          : code === "timeout"
            ? EXIT_CODES.timeout
            : EXIT_CODES.usage
    );
  }
  if (quiet) {
    const answer = (response.result as { stdout?: unknown } | null)?.stdout;
    process.stdout.write(typeof answer === "string" ? answer : "");
    return;
  }
  process.stdout.write(JSON.stringify(response.result, null, 2) + "\n");
}

void main();
