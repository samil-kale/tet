import * as http from "node:http";
import { CONTROL_ENV, CONTROL_FLAGS, CONTROL_VERBS, EXIT_CODES, HELP_VERB } from "../shared/control";
import type { ControlRequest, ControlResponse, ControlVerb } from "../shared/control";

/**
 * `tet-ctl`: how an agent in a tet terminal asks the app. No electron; bundled on its own
 * (esbuild.js), started by the launcher in ~/.tet/bin; the environment says where tet listens and
 * who the caller is (src/shared/control.ts). Output is for an agent: JSON on stdout, one line on
 * stderr on failure, and an exit code to branch on.
 */

/** What a skill file would say at the top: when this is the right tool at all. TET_SYSTEM_PROMPT
 *  spends its one line sending an agent here, so the answer to "when do I run this" belongs in the
 *  same output as the verbs: nothing to install into an agent's own configuration, and all four
 *  read it the same way. */
const WHEN_TO_USE = [
  "This terminal is one tab of one project in TET; other tabs run other agents, shells and saved",
  "commands, and the user watches them all. tet-ctl answers what the filesystem and git cannot:",
  "what TET shows, what the other tabs are doing, and what the user has in front of them — reach",
  "for it when the user asks about TET itself, means something they ran or saw in another tab",
  "(\"the error in the shell\", \"what did codex say\"), wants something put in front of them rather",
  "than in your answer, or when another agent or a saved command should do the job.",
  "",
  "Leave it alone for files and git: read the repository and run git yourself."
];

/** The verbs in the order help prints them, under the question each group answers; every verb is
 *  in exactly one group (control.test.ts). Grouping is what the list gives an agent that the verb
 *  names alone do not, so it replaces the walkthrough that used to name them a second time. */
const GROUPS: ReadonlyArray<{ heading: string; verbs: readonly string[] }> = [
  {
    heading: "TET itself",
    verbs: [
      "help",
      "version",
      "settings-get",
      "list-themes",
      "list-agents",
      "settings-set-theme",
      "settings-set-color-scheme",
      "settings-set-prompt",
      "projects-list",
      "projects-add",
      "projects-remove",
      "repo-state",
      "restart-app"
    ]
  },
  {
    heading: "The other tabs",
    verbs: [
      "tabs-list",
      "tabs-output",
      "events-tail",
      "tabs-wait",
      "tabs-send",
      "tabs-create",
      "tabs-run-command",
      "tabs-start",
      "tabs-restart",
      "tabs-rename",
      "tabs-close"
    ]
  },
  {
    heading: "In front of the user",
    verbs: ["editor-open", "editor-state", "editor-list", "explorer-list", "notices-list", "notify"]
  },
  { heading: "TET's own plumbing", verbs: ["hook"] }
];

/** Each verb's summary on its own indented line: padding every usage to the longest one (tabs-wait)
 *  cost an agent reading this some 140 spaces a line. */
function usage(): string {
  const listed = (verb: string): ControlVerb | undefined => CONTROL_VERBS.find((entry) => entry.verb === verb);
  return [
    "tet-ctl — control the TET app this terminal runs in",
    "",
    ...WHEN_TO_USE,
    ...GROUPS.flatMap((group) => [
      "",
      group.heading,
      ...group.verbs.flatMap((verb) => {
        const entry = listed(verb);
        return entry ? [`  ${entry.usage}`, `      ${entry.summary}`] : [];
      })
    ]),
    "",
    "Without --project, a verb acts on the project of the tab it is run from. restartRequired in an",
    "answer means the change waits for a restart — tell the user, never restart for them.",
    "Refused whatever the list says (exit 2, the reason on stderr): a terminal of another project",
    "(tabs-output, tabs-send), and from a tab running in an sbx sandbox everything that acts on this",
    "machine — the other tabs included."
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
  if (positionals.length > entry.positionals.length) {
    fail(`too many arguments\n\n  ${entry.usage}`, EXIT_CODES.usage);
  }
  entry.positionals.forEach((name, index) => {
    if (positionals[index] !== undefined) {
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
 * good. Given up on, it answers nothing, and that prompt goes without the context text.
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
    fail(`could not reach TET: ${error instanceof Error ? error.message : String(error)}`, EXIT_CODES.internal);
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
