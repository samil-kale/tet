import * as fs from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "write-file-atomic";

/**
 * A GIT_ASKPASS script answering from environment variables, for TET's own git runs and for its host
 * tabs. One sh script everywhere: Git for Windows runs a non-exe askpass through its own sh. No
 * secret in it. git's question is `$1`: "Username for 'https://host': " or "Password for
 * 'https://user@host': ", the url with its path under `credential.useHttpPath`, and the host as the
 * remote's url spells it, while TET_ASKPASS_ORIGIN (urlOrigin) is lowercase without a default port.
 * It answers only for that origin: a submodule, a pushurl or a redirect on another host gets nothing,
 * and git fails there for want of a login rather than being handed one for elsewhere.
 */
const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  'url=${1#*"\'"}',
  'url=${url%"\'"*}',
  "host=${url#*://}",
  "host=${host%%/*}",
  "host=${host#*@}",
  "origin=$(printf '%s' \"${url%%://*}://$host\" | tr '[:upper:]' '[:lower:]')",
  'case "$origin" in https://*:443) origin=${origin%:443} ;; http://*:80) origin=${origin%:80} ;; esac',
  '[ "$origin" = "$TET_ASKPASS_ORIGIN" ] || exit 1',
  'case "$1" in',
  "Username*) printf '%s\\n' \"$TET_ASKPASS_USER\" ;;",
  "Password*) printf '%s\\n' \"$TET_ASKPASS_TOKEN\" ;;",
  "*) exit 1 ;;",
  "esac",
  "",
].join("\n");

/** What ASKPASS_SCRIPT answers with: the one origin, and the login for it. */
export interface AskpassLogin {
  origin: string;
  username: string;
  password: string;
}

/** The variables that hand `login` to git through the script at `askpass`. */
export function askpassEnv(askpass: string, login: AskpassLogin): Record<string, string> {
  return {
    GIT_ASKPASS: askpass,
    TET_ASKPASS_ORIGIN: login.origin,
    TET_ASKPASS_USER: login.username,
    TET_ASKPASS_TOKEN: login.password,
  };
}

/** The script in `dir` (TET's data folder), written when missing or from another TET — not on
 *  every call: on Windows a rename over the script while an sh reads it fails, and two commands
 *  reaching remotes at once (the periodic fetches) would race. Not the temp directory: git executes
 *  the script itself, which a `noexec` /tmp refuses, and a long-running TET would find it cleaned
 *  away. */
export async function ensureAskpass(dir: string): Promise<string> {
  const file = path.join(dir, "askpass.sh");
  const current = await fs.readFile(file, "utf8").catch(() => undefined);
  if (current !== ASKPASS_SCRIPT) {
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(file, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o755 });
  }
  return file;
}
