import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ExplorerRoot,
  ExplorerSettings,
  ExplorerSortOrder,
  ProjectCommand,
  SbxAccess,
  SbxPath,
  SbxKnowledgeConfig,
  SbxPort,
  SbxProjectConfig
} from "../../shared/types";

/**
 * What a project keeps about itself in its own root: shell commands — "npm run build", a deploy
 * script, whatever is typed often enough to be worth a button — and how its Explorer tree is shown.
 * Shaped like a VS Code `.code-workspace`: `folders` at the top level, the view settings nested
 * under `settings` by their full VS Code name (`files.exclude`, `explorer.excludeGitIgnore`,
 * `explorer.compactFolders`, `explorer.sortOrder`; see `readExplorerView`). They live in the
 * repository rather than in tet's own storage, so they travel with it like any other project
 * file.
 */
const FILE = "tet.json";

/**
 * What that file holds. A command is a plain string while the command line alone says
 * everything, and an object once it needs a directory, variables or a shell — so the common
 * case stays a one-line entry a person can read, and a file full of strings stays valid.
 */
type StoredCommand =
  | string
  | { command?: unknown; name?: unknown; cwd?: unknown; env?: unknown; shell?: unknown };

interface ProjectFile {
  commands?: StoredCommand[];
  folders?: unknown;
  settings?: unknown;
  /** The sbx-settings dialog's Save button — see readSbxConfig/writeSbxConfig. Never a credential:
   *  each sandboxed agent signs in inside its own sandbox. */
  sbx?: unknown;
}

/** The four view settings' keys, spelled the way VS Code itself does inside `settings`. */
const KEY_EXCLUDE = "files.exclude";
const KEY_EXCLUDE_GIT_IGNORE = "explorer.excludeGitIgnore";
const KEY_COMPACT_FOLDERS = "explorer.compactFolders";
const KEY_SORT_ORDER = "explorer.sortOrder";

/**
 * How the Explorer tree shows this project — VS Code's `folders` list and `files.exclude` /
 * `explorer.*` settings, read the same defensive way as the commands: anything not of the
 * expected shape is its default, never an error.
 */
export interface ExplorerView {
  /** Top-level nodes; empty means the whole repository as one tree. */
  folders: ExplorerRoot[];
  /** `files.exclude`'s globs, matched against repository-relative paths. */
  exclude: string[];
  /** `explorer.excludeGitIgnore`: hide what git ignores too. */
  excludeGitIgnore: boolean;
  /** `explorer.compactFolders`: fold `src/main/java` into one row. */
  compactFolders: boolean;
  /** `explorer.sortOrder`. */
  sortOrder: ExplorerSortOrder;
}

const SORT_ORDERS: readonly ExplorerSortOrder[] = ["default", "mixed", "filesFirst", "type", "modified", "foldersNestsFiles"];

/**
 * What `read` answers for a file that is there but does not parse — the one `patch` must not
 * write over, since it would replace whatever the user has in there with only our key.
 */
const UNREADABLE: ProjectFile = {};

function file(root: string): string {
  return path.join(root, FILE);
}

/**
 * The file's contents, or **null** when there is no tet.json at all. One that is there but
 * unreadable or shaped differently is no commands rather than none: it is a file in the user's
 * repository, and half of it being someone else's is reason neither to throw nor to write over
 * it. The distinction stays inside this module so writes may create a missing file but refuse
 * to replace a broken one.
 */
async function read(root: string): Promise<ProjectFile | null> {
  let content: string;
  try {
    content = await fs.readFile(file(root), "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(content) as ProjectFile;
  } catch {
    // There is a file, it just isn't ours to read. Not nothing, but nothing usable.
    return UNREADABLE;
  }
}

/** Writes one key, keeping every other the file already holds. */
async function patch(root: string, changes: Partial<ProjectFile>): Promise<void> {
  await write(root, { ...(await readForPatch(root)), ...changes });
}

/** The file as it is, for an edit — the one a broken file must not be written over by. */
async function readForPatch(root: string): Promise<ProjectFile> {
  const content = (await read(root)) ?? {};
  if (content === UNREADABLE) {
    throw new Error(`${FILE} is not valid JSON`);
  }
  return content;
}

function write(root: string, content: ProjectFile): Promise<void> {
  return fs.writeFile(file(root), `${JSON.stringify(content, undefined, 2)}\n`, "utf8");
}

/** Only the string values of an `env`; anything else in there is not an environment. */
function toEnv(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const env = Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string")
  );
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Both spellings in, one shape out; anything that is neither is dropped. */
function toCommand(entry: StoredCommand): ProjectCommand | undefined {
  if (typeof entry === "string") {
    return entry.trim() ? { command: entry } : undefined;
  }
  if (typeof entry?.command !== "string" || !entry.command.trim()) {
    return undefined;
  }
  const command: ProjectCommand = { command: entry.command };
  if (typeof entry.name === "string" && entry.name.trim()) {
    command.name = entry.name;
  }
  if (typeof entry.cwd === "string" && entry.cwd.trim()) {
    command.cwd = entry.cwd;
  }
  const env = toEnv(entry.env);
  if (env) {
    command.env = env;
  }
  if (entry.shell === true) {
    command.shell = true;
  }
  return command;
}


export async function readCommands(root: string): Promise<ProjectCommand[]> {
  const content = await read(root);
  if (!content || !Array.isArray(content.commands)) {
    return [];
  }
  return content.commands.map(toCommand).filter((command): command is ProjectCommand => command !== undefined);
}

export function writeCommands(root: string, commands: ProjectCommand[]): Promise<void> {
  // Back to the short form wherever there is nothing else to say about the command.
  return patch(root, {
    commands: commands.map((command) =>
      command.name || command.cwd || command.env || command.shell ? command : command.command
    )
  });
}

/**
 * A `folders` entry's path the way the tree keys everything: repository-relative with forward
 * slashes, "" for the root. Undefined for anything that is not a path inside the repository —
 * an absolute path, one climbing out with `..`, a non-string — which is simply skipped, like a
 * command with no command line.
 */
function toFolderPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = path.posix.normalize(value.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") {
    return "";
  }
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    return undefined;
  }
  return normalized;
}

/** The path of a stored entry — `{ path }` or, tolerated, a bare string. */
function storedPath(entry: unknown): string | undefined {
  return toFolderPath(typeof entry === "string" ? entry : (entry as { path?: unknown } | null)?.path);
}

/** `folders` as stored, turned into roots; a duplicate path is one root. */
function toFolders(value: unknown, root: string): ExplorerRoot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const folders: ExplorerRoot[] = [];
  for (const entry of value) {
    const folderPath = storedPath(entry);
    if (folderPath === undefined || folders.some((folder) => folder.path === folderPath)) {
      continue;
    }
    const stored = typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : undefined;
    const name = typeof stored === "string" ? stored.trim() : "";
    folders.push({ path: folderPath, name: name || path.basename(folderPath || path.resolve(root)) });
  }
  return folders;
}

/** `settings`, defensively: anything not an object is no settings at all. */
function toSettings(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `files.exclude`'s patterns: VS Code's map of glob → true; only the ones set to true count. */
function toExclude(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(([pattern, enabled]) => enabled === true && pattern.trim())
    .map(([pattern]) => pattern);
}

export async function readExplorerView(root: string): Promise<ExplorerView> {
  const content = (await read(root)) ?? {};
  const settings = toSettings(content.settings);
  return {
    folders: toFolders(content.folders, root),
    exclude: toExclude(settings[KEY_EXCLUDE]),
    excludeGitIgnore: settings[KEY_EXCLUDE_GIT_IGNORE] === true,
    compactFolders: settings[KEY_COMPACT_FOLDERS] !== false,
    sortOrder: SORT_ORDERS.find((order) => order === settings[KEY_SORT_ORDER]) ?? "default"
  };
}

/** `readExplorerView`'s defaults for a project with no tet.json at all — the one place ipc.ts's
 *  fallbacks for a missing repository read them from, so the three values can't drift apart. */
export const DEFAULT_EXPLORER_VIEW: ExplorerSettings = {
  excludeGitIgnore: false,
  compactFolders: true,
  sortOrder: "default"
};

/**
 * The Explorer tree's "Add Folder to Workspace". A project with no `folders` yet is the whole
 * repository as one tree, so the first add writes that root down alongside the new folder —
 * VS Code's own move when a single-folder window gets a second folder — rather than narrowing
 * the view to the new one. Entries are kept as written, so a `name` survives.
 */
export async function addFolder(root: string, folderPath: string): Promise<void> {
  const content = await readForPatch(root);
  const folders = Array.isArray(content.folders) ? (content.folders as unknown[]) : [];
  if (folders.some((entry) => storedPath(entry) === folderPath)) {
    return;
  }
  const kept = folders.length === 0 ? [{ path: "." }] : folders;
  await write(root, { ...content, folders: [...kept, { path: folderPath }] });
}

/** "Remove Folder from Workspace": the last one gone means no `folders` at all — the whole
 *  repository again, not an empty tree. */
export async function removeFolder(root: string, folderPath: string): Promise<void> {
  const content = await readForPatch(root);
  const folders = (Array.isArray(content.folders) ? (content.folders as unknown[]) : []).filter(
    (entry) => storedPath(entry) !== folderPath
  );
  if (folders.length > 0) {
    await write(root, { ...content, folders });
    return;
  }
  const rest: ProjectFile = { ...content };
  delete rest.folders;
  await write(root, rest);
}

/** Writes one key inside `settings`, keeping every other setting and top-level key as they are. */
async function patchSetting(root: string, key: string, value: unknown): Promise<void> {
  const content = await readForPatch(root);
  const settings = toSettings(content.settings);
  await write(root, { ...content, settings: { ...settings, [key]: value } });
}

/** "Exclude from Files": the path itself as a pattern, set to true the way VS Code stores it. */
export async function addExclude(root: string, relPath: string): Promise<void> {
  const content = await readForPatch(root);
  const settings = toSettings(content.settings);
  const existing =
    typeof settings[KEY_EXCLUDE] === "object" && settings[KEY_EXCLUDE] !== null && !Array.isArray(settings[KEY_EXCLUDE])
      ? (settings[KEY_EXCLUDE] as Record<string, unknown>)
      : {};
  await write(root, {
    ...content,
    settings: { ...settings, [KEY_EXCLUDE]: { ...existing, [relPath]: true } }
  });
}

/** The three file-only view settings, set from the settings dialog's Files tab. */
export async function setExcludeGitIgnore(root: string, value: boolean): Promise<void> {
  await patchSetting(root, KEY_EXCLUDE_GIT_IGNORE, value);
}

export async function setCompactFolders(root: string, value: boolean): Promise<void> {
  await patchSetting(root, KEY_COMPACT_FOLDERS, value);
}

export async function setSortOrder(root: string, value: ExplorerSortOrder): Promise<void> {
  await patchSetting(root, KEY_SORT_ORDER, value);
}

const SBX_ACCESS: readonly SbxAccess[] = ["Read", "Read+Write"];

function toSbxPorts(value: unknown): SbxPort[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ports: SbxPort[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { host, container } = entry as { host?: unknown; container?: unknown };
    if (typeof host === "string" && typeof container === "string" && host.trim() && container.trim()) {
      ports.push({ host, container });
    }
  }
  return ports;
}

/**
 * An allowed-path row as tet.json holds it: the dialog's row plus, for a path outside the
 * home, the platform it was entered on. tet.json travels with the repository, and an absolute
 * path means nothing on another OS (`C:\…` on Linux, `/home/…` on Windows), so such a row is
 * that platform's alone: readSbxConfig hands out only this platform's rows, and writeSbxConfig
 * replaces only those, leaving what a colleague on another OS saved untouched. A `~/…` row
 * (what saveSbxConfig stores every path under the home as — see sbx.ts's contractHome) resolves
 * on every OS, so it carries no `os` and is everyone's. Neither the dialog nor sbx.ts ever sees
 * the field — the OS is whatever tet is running on, never a choice.
 */
interface StoredSbxPath extends SbxPath {
  os?: string;
}

/** Whether a stored row applies here — its platform's, or everyone's. */
function appliesHere(entry: StoredSbxPath): boolean {
  return entry.os === undefined || entry.os === process.platform;
}

function toSbxPaths(value: unknown): StoredSbxPath[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: StoredSbxPath[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { path: hostPath, access, os } = entry as { path?: unknown; access?: unknown; os?: unknown };
    if (typeof hostPath === "string" && hostPath.trim()) {
      const row: StoredSbxPath = { path: hostPath, access: SBX_ACCESS.find((candidate) => candidate === access) ?? "Read+Write" };
      if (typeof os === "string") {
        row.os = os;
      }
      paths.push(row);
    }
  }
  return paths;
}

function sbxSection(content: ProjectFile): Record<string, unknown> {
  return typeof content.sbx === "object" && content.sbx !== null ? (content.sbx as Record<string, unknown>) : {};
}

/** `knowledge`'s on-disk access codes — short because there is one of these per kind per agent
 *  rather than per user-picked row the way an allowed path's `access` is. */
const KNOWLEDGE_ACCESS_CODE: Record<SbxAccess, "r" | "rw"> = { Read: "r", "Read+Write": "rw" };
const KNOWLEDGE_ACCESS_FROM_CODE: Partial<Record<string, SbxAccess>> = { r: "Read", rw: "Read+Write" };

/** A malformed or missing `knowledge` object reads as every kind off — never partially on from a
 *  field that happens to be truthy by accident. */
function toSbxKnowledge(value: unknown): SbxKnowledgeConfig {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const toAccess = (field: unknown): SbxAccess | false =>
    (typeof field === "string" ? KNOWLEDGE_ACCESS_FROM_CODE[field] : undefined) ?? false;
  return { skills: toAccess(record.skills), plugins: toAccess(record.plugins), instructions: toAccess(record.instructions) };
}

function toStoredKnowledge(knowledge: SbxKnowledgeConfig): Record<keyof SbxKnowledgeConfig, "r" | "rw" | false> {
  const toCode = (access: SbxAccess | false): "r" | "rw" | false => (access ? KNOWLEDGE_ACCESS_CODE[access] : false);
  return { skills: toCode(knowledge.skills), plugins: toCode(knowledge.plugins), instructions: toCode(knowledge.instructions) };
}

/**
 * The sbx-settings dialog's persisted state — read the same defensively-anything-goes way as the
 * rest of tet.json. Never holds a token: each sandboxed agent signs in with its own `/login`
 * inside the sandbox, nothing tet stores ever needs to.
 */
export async function readSbxConfig(root: string): Promise<SbxProjectConfig> {
  const sbx = sbxSection((await read(root)) ?? {});
  const paths = toSbxPaths(sbx.paths)
    .filter(appliesHere)
    .map(({ path: hostPath, access }) => ({ path: hostPath, access }));
  return { enabled: sbx.enabled === true, knowledge: toSbxKnowledge(sbx.knowledge), ports: toSbxPorts(sbx.ports), paths };
}

/** Writes the rows that apply here in place of the previous ones — see StoredSbxPath. */
export async function writeSbxConfig(root: string, config: SbxProjectConfig): Promise<void> {
  const content = await readForPatch(root);
  const others = toSbxPaths(sbxSection(content).paths).filter((entry) => !appliesHere(entry));
  const mine = config.paths.map((entry): StoredSbxPath => (entry.path.startsWith("~") ? entry : { ...entry, os: process.platform }));
  await write(root, {
    ...content,
    sbx: { enabled: config.enabled, knowledge: toStoredKnowledge(config.knowledge), ports: config.ports, paths: [...others, ...mine] }
  });
}
