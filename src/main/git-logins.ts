import * as fs from "node:fs";
import * as path from "node:path";
import { urlOrigin, urlUsername } from "../shared/git-url";
import type { GitActionResult, GitLogin } from "../shared/types";
import { git } from "./git/git-client";
import type { NetworkLogin } from "./git/git";
import { saveJson } from "./json-file";
import { seal, unseal } from "./sealed";

/** What the file holds: one login per origin and username, its password encrypted by the OS and
 *  base64-wrapped. */
interface StoredLogin {
  origin: string;
  username: string;
  password: string;
}

/**
 * The logins typed into tet for a host where git has no credential helper to keep them (on Linux
 * by default). Where there is one, git stores the login there itself and nothing lands here. A
 * password leaves this class only decrypted into a git command's environment (git.ts's askpass).
 */
export class GitLoginStore {
  private readonly file: string;
  private logins: StoredLogin[] = [];
  /** Where git.ts writes the askpass script handing a login to git. */
  readonly askpassDir: string;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, "git-logins.json");
    this.askpassDir = path.join(dataRoot, "askpass");
    this.load();
  }

  /**
   * Runs a command reaching `url` with the login typed for it (`typed`, the second try), or else
   * the one kept here. Refused for want of a login, it comes back with `loginUrl` for the view to
   * ask, and a kept login the host refused is forgotten, so the question comes. A typed login that
   * worked is kept here only where git has no credential helper, which has stored it by now. A
   * url with no login to type (urlOrigin) passes the command through untouched.
   */
  async run(
    cwd: string,
    url: string,
    typed: GitLogin | undefined,
    command: (login?: NetworkLogin) => Promise<GitActionResult>
  ): Promise<GitActionResult> {
    const origin = urlOrigin(url);
    if (!origin) {
      return command();
    }
    const kept = typed ? undefined : this.get(url);
    const login = typed ?? kept;
    const result = await command(login && { ...login, askpassDir: this.askpassDir, origin });
    if (result.authRequired) {
      if (kept) {
        this.delete(url, kept.username);
      }
      // Never with a password in it: urlOrigin passed such a url through above.
      return { ...result, loginUrl: url };
    }
    // The command went through: the git process dying on this question must not make it fail.
    if (result.ok && typed && !(await git.hasCredentialHelper(cwd, url).catch(() => false))) {
      this.set(url, typed);
    }
    return result;
  }

  /** The login for this url's origin — its username's, where the url names one, else the latest
   *  kept; undefined when none, or sealed under a keychain this machine no longer has. */
  get(url: string): GitLogin | undefined {
    const origin = urlOrigin(url);
    const username = urlUsername(url);
    const entry = this.logins
      .filter((login) => login.origin === origin && (username === "" || login.username === username))
      .at(-1);
    const password = entry && unseal(entry.password);
    return entry && password !== undefined ? { username: entry.username, password } : undefined;
  }

  /** Keeps the login, replacing what its origin had for the same username. Where the OS offers no
   *  encryption nothing is kept, and the next command asks again. */
  set(url: string, login: GitLogin): void {
    const origin = urlOrigin(url);
    if (!origin) {
      return;
    }
    let password: string;
    try {
      password = seal(login.password);
    } catch (error) {
      console.error("[tet] could not keep the git login:", error);
      return;
    }
    this.logins = [
      ...this.logins.filter((entry) => entry.origin !== origin || entry.username !== login.username),
      { origin, username: login.username, password }
    ];
    this.save();
  }

  /** Forgets this user's login for the url's origin, which the host refused. */
  delete(url: string, username: string): void {
    const origin = urlOrigin(url);
    const kept = this.logins.filter((entry) => entry.origin !== origin || entry.username !== username);
    if (kept.length !== this.logins.length) {
      this.logins = kept;
      this.save();
    }
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed)) {
        this.logins = parsed.filter(
          (entry): entry is StoredLogin =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as StoredLogin).origin === "string" &&
            typeof (entry as StoredLogin).username === "string" &&
            typeof (entry as StoredLogin).password === "string"
        );
      }
    } catch {
      // No file yet, or unreadable — no logins.
      this.logins = [];
    }
  }

  private save(): void {
    saveJson(this.file, this.logins, "git logins");
  }
}
