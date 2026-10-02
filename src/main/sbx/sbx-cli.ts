import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { SBX_PROBLEM } from "../../shared/sbx-rules";
import { isSimulatedMissing } from "../util/simulate";
import { runProcess, stoppable } from "../util/process";
import { PLATFORM } from "../util/host-platform";
import { logError } from "../util/error-log";
import { parseSbxJson } from "./sbx-policy";

/**
 * The `sbx` process the settings dialog waits on, for `cancelSbxSetup`. Only `login` and `policy
 * init` run here (`RunOptions.cancellable`): a spawn's `sbx ls` or `create` must survive Cancel.
 */
const setup = stoppable();

interface RunOptions {
  /** Written to stdin, then closed. Without it stdin is closed from the start, so a command waiting
   *  on it fails. */
  stdin?: string;
  /** Whether `cancelSbxSetup` may kill this one. */
  cancellable?: boolean;
  /** Killed after this long, answering as failed. */
  timeoutMs?: number;
  /**
   * Forwards stdout and stderr live, in arrival order, to the tab about to run in the sandbox (its
   * `onOutput` channel), `\n` as `\r\n`: xterm has no `convertEol`.
   */
  onData?: (chunk: string) => void;
}

export type OnData = RunOptions["onData"];

export interface RunResult {
  /** Exited 0. */
  ok: boolean;
  /** The exit code; null when sbx could not start, died of a signal or timed out (runProcess). */
  code: number | null;
  stdout: string;
  /** sbx's own errors and those of a command it ran. */
  stderr: string;
}

/** How much of sbx's last line a message keeps, from its end: a daemon that would not start puts
 *  its whole start log on that one line, the error last. */
const MAX_ERROR_LENGTH = 300;

/** What sbx said on failing: its last line, `ERROR: …` without the prefix — progress lines
 *  ("Starting sandboxd daemon...") precede it — cut to its end past MAX_ERROR_LENGTH. Empty when
 *  it said nothing. */
export function sbxError(result: RunResult): string {
  const line = result.stderr.trim().split(/\r?\n/).pop()?.replace(/^ERROR:\s*/, "") ?? "";
  return line.length > MAX_ERROR_LENGTH ? `…${line.slice(-MAX_ERROR_LENGTH).trimStart()}` : line;
}

/** How much of each stream a logged failure keeps, from its end. */
const MAX_LOGGED_OUTPUT = 2000;

/**
 * A run the caller takes for a failure, not for one of sbx's answers: logged whole, as what the
 * message drops is what tells why, and worded as sbxError, else `<command> failed`.
 */
export function sbxFailure(result: RunResult, command: string): string {
  logError(
    `${command} failed (exit ${result.code ?? "none"})\nstdout: ${result.stdout.trim().slice(-MAX_LOGGED_OUTPUT)}\nstderr: ${result.stderr.trim().slice(-MAX_LOGGED_OUTPUT)}`
  );
  return sbxError(result) || `${command} failed`;
}

/** Why sbx refused, as a problem's reason (SbxProblems): what it said, else that it refused. */
export function sbxRefusal(result: RunResult): string {
  return sbxError(result) || SBX_PROBLEM.refused;
}

/** Every `sbx` invocation: a plain spawn through `resolveCommand` (runProcess), no shell, from the
 *  temp directory so the working directory never reads as a workspace. */
export async function runSbx(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const run = (onSpawn?: (child: ChildProcess) => void) =>
    runProcess("sbx", args, {
      cwd: os.tmpdir(),
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      onData: options.onData && ((chunk) => options.onData?.(chunk.replace(/\n/g, "\r\n"))),
      onSpawn
    });
  const result = options.cancellable ? await setup.run(run) : await run();
  return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** A `--json` run's stdout parsed: undefined when sbx failed or printed no JSON, so a reader
 *  answers "sbx cannot say" rather than an empty list. The shape is the caller's claim, read
 *  defensively at its site. */
export function jsonOf<T>(result: RunResult): T | undefined {
  if (!result.ok) {
    return undefined;
  }
  try {
    return parseSbxJson(result.stdout) as T;
  } catch {
    return undefined;
  }
}

/** One `sbx … --json` read (jsonOf). */
export async function sbxJson<T>(args: string[]): Promise<T | undefined> {
  return jsonOf<T>(await runSbx(args));
}

/** For the dialog's Cancel. */
export function cancelSbxSetup(): void {
  setup.stop();
}

/** The sbx version test/e2e/agents.test.ts last passed against (TET_SBX_TEST=1); read by nothing in
 *  the app. */
export const SBX_VERIFIED_VERSION = "0.45.1";

/** As long as an agent's version check, for `sbx version` and probeSbx's reads beside it: a hung
 *  daemon must hold neither the startup, the SBX dialog nor a tab's start. */
export const SBX_PROBE_TIMEOUT_MS = 10_000;

/**
 * `sbx version --json`'s client version, without its "v" (`version` is a subcommand; `sbx
 * --version` fails with "unknown flag"); undefined when sbx is not installed or does not answer in
 * time — the startup's and probeSbx's sign of it — "" when it named no version.
 */
export async function readSbxVersion(): Promise<string | undefined> {
  if (isSimulatedMissing("sbx")) {
    return undefined;
  }
  const result = await runSbx(["version", "--json"], { timeoutMs: SBX_PROBE_TIMEOUT_MS });
  if (!result.ok) {
    return undefined;
  }
  const version = jsonOf<{ client?: { version?: unknown } }>(result)?.client?.version;
  return typeof version === "string" ? version.replace(/^v/, "") : "";
}

/** Whether that version keeps a sandbox's live mounts across a stop and lists them in
 *  `sbx inspect` (mountAll). */
export function sbxVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => parseInt(part, 10) || 0);
  return major > 0 || minor >= 45;
}

/**
 * sbx shows a one-time wizard on a machine's first interactive `sbx run` (a tet tab is one). Any
 * valid JSON at its marker file (Platform.sbxFirstRunMarker) suppresses it; an existing file is
 * kept. Loses the wizard's MCP-server import (`sbx mcp add` by hand). A no-op where sbx shows no
 * wizard. Best-effort.
 */
export async function suppressSbxFirstRunWizard(): Promise<void> {
  const markerFile = PLATFORM.sbxFirstRunMarker(process.env);
  if (!markerFile) {
    return;
  }
  try {
    await fs.access(markerFile);
    return;
  } catch {
    // Not there yet.
  }
  try {
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    await writeFileAtomic(markerFile, "{}");
  } catch {
    // Worst case the wizard shows once.
  }
}

/** `sbx login` opens the browser and waits on its own callback; no console needed. */
export async function runSbxLogin(): Promise<boolean> {
  return (await runSbx(["login"], { cancellable: true })).ok;
}

/** The user `sbx login` names while signed in ("You are signed in [username: <name>]" on stdout,
 *  exit 0, no browser). Text, since no sbx command names the user otherwise. Worth checking on a
 *  newer sbx for a structured answer. */
export function parseSignedInUser(stdout: string): string | undefined {
  return /\[username: ([^\]]+)\]/.exec(stdout)?.[1].trim() || undefined;
}

/** Generous for a signed-in answer (parseSignedInUser). */
const SBX_USER_TIMEOUT_MS = 10_000;

/** Who is signed in, which nothing but `sbx login` tells (parseSignedInUser) — asked only once the
 *  status said signed in, since signed out it opens the browser and waits: signed out in between,
 *  it is killed after SBX_USER_TIMEOUT_MS and the user is unknown. `cancellable` only for the
 *  dialog: `cancelSbxSetup` kills one child, never a control request's. */
export async function readSbxUser(cancellable: boolean): Promise<string | undefined> {
  return parseSignedInUser((await runSbx(["login"], { cancellable, timeoutMs: SBX_USER_TIMEOUT_MS })).stdout);
}

/**
 * `sbx login` with a Docker access token on stdin; what sbx said on refusing, else undefined. sbx
 * reads no token from the environment. Signed in already, it switches: another account's login
 * keeps running sandboxes running and listed, a refused one keeps the sign-in there was;
 * governance follows the account at once.
 */
export async function runSbxTokenLogin(user: string, token: string, cancellable: boolean): Promise<string | undefined> {
  const result = await runSbx(["login", "--username", user, "--password-stdin"], { stdin: token, cancellable });
  return result.ok ? undefined : sbxFailure(result, "sbx login");
}

/** `sbx logout` stops every running local sandbox; `--yes` skips its "Proceed y/N?", which a closed
 *  stdin would cancel. */
export async function runSbxLogout(): Promise<string | undefined> {
  const result = await runSbx(["logout", "--yes"]);
  return result.ok ? undefined : sbxFailure(result, "sbx logout");
}

/**
 * The machine-wide network policy "balanced", Docker's recommended default — no per-project choice:
 * changing it needs `sbx policy reset`, which stops every running sandbox.
 */
export async function initSbxPolicy(): Promise<boolean> {
  return (await runSbx(["policy", "init", "balanced"], { cancellable: true })).ok;
}
