import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Where a linked worktree's or a submodule's git data lives, read off its `.git` file — no git
 * process: `gitDir` the file names, and for a worktree the `commonDir` its `commondir` points at
 * (the repository's `.git`). Undefined for a `.git` directory (the usual repository) or none.
 * Synchronous, for `ProjectStore.load` and the watcher setup.
 */
export function readLinkedGitDir(root: string): { gitDir: string; commonDir?: string } | undefined {
  let gitDir: string;
  try {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(root, ".git"), "utf8"));
    if (!pointer) {
      return undefined;
    }
    gitDir = path.resolve(root, pointer[1]);
  } catch {
    return undefined;
  }
  try {
    return { gitDir, commonDir: path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()) };
  } catch {
    // A submodule: no common directory.
    return { gitDir };
  }
}

/** The branch a `HEAD` file's text names; undefined while detached. */
export function headBranch(head: string): string | undefined {
  return /^ref: refs\/heads\/(.+?)\s*$/m.exec(head)?.[1];
}

/** The branch a linked worktree has checked out, off its git directory's HEAD; undefined while
 *  detached or unreadable. Synchronous, for the store's first frame and before a delete. */
export function readHeadBranch(root: string): string | undefined {
  const gitDir = readLinkedGitDir(root)?.gitDir;
  try {
    return headBranch(gitDir === undefined ? "" : fs.readFileSync(path.join(gitDir, "HEAD"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A linked worktree's repository, the folder holding the common `.git`; undefined otherwise. In
 * on-disk spelling, as `git rev-parse --show-toplevel` gives a project's path, so the two compare
 * as strings.
 */
export function readRepositoryPath(root: string): string | undefined {
  const commonDir = readLinkedGitDir(root)?.commonDir;
  if (commonDir === undefined) {
    return undefined;
  }
  try {
    return fs.realpathSync.native(path.dirname(commonDir));
  } catch {
    // The repository is gone; the worktree is no longer one either.
    return undefined;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The repository's project id, `tet.id` in its own config file as `git config --local --get` reads
 * it (a linked worktree reads the repository's, which is the point; includes are not followed),
 * without starting git; undefined where it has none, or none valid. Rejects where the file cannot
 * be read (the folder gone): no answer is not "none", which would replace it.
 */
export async function readProjectId(root: string): Promise<string | undefined> {
  const linked = readLinkedGitDir(root);
  const gitDir = linked ? (linked.commonDir ?? linked.gitDir) : path.join(root, ".git");
  const id = gitConfigValue(await fs.promises.readFile(path.join(gitDir, "config"), "utf8"), "tet", "id") ?? "";
  return UUID.test(id) ? id.toLowerCase() : undefined;
}

/**
 * The last value of `key` in `[section]` (no subsection) of a git config file's text, as git parses
 * it: names without case, quotes and backslash escapes in the value, `#` and `;` comments outside
 * quotes. A key without `=` is git's boolean true and gives "".
 */
export function gitConfigValue(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  let value: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    const header = /^\[\s*([^\]\s"]+)\s*(?:"(?:[^"\\]|\\.)*"\s*)?\]/.exec(line);
    if (header) {
      // A subsection (`[tet "x"]`) is another section than `[tet]`.
      inSection = header[1].toLowerCase() === section.toLowerCase() && !header[0].includes('"');
      line = line.slice(header[0].length).trim();
    }
    if (!inSection || line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(=(.*))?$/.exec(line);
    if (entry?.[1].toLowerCase() === key.toLowerCase()) {
      value = entry[2] === undefined ? "" : configString(entry[3]);
    }
  }
  return value;
}

/** A value's text: quotes dropped, escapes resolved, a comment outside quotes cut, the ends trimmed. */
function configString(raw: string): string {
  let out = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === "\\" && index + 1 < raw.length) {
      const next = raw[++index];
      out += next === "n" ? "\n" : next === "t" ? "\t" : next === "b" ? "\b" : next;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "#" || char === ";")) {
      break;
    } else {
      out += char;
    }
  }
  return out.trim();
}
