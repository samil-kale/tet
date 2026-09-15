import * as fs from "node:fs/promises";
import * as path from "node:path";
// The ESM build: esbuild can't follow the UMD build's `require("./impl/format")`.
import { applyEdits, modify, parse as parseJsonc, type JSONPath, type ParseError } from "jsonc-parser/lib/esm/main.js";
import writeFileAtomic from "write-file-atomic";
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

/** A project's saved commands and Explorer view, in its own root so it travels with the repository.
 *  Shaped like a VS Code `.code-workspace`: `folders` at the top, view settings under `settings` by
 *  their VS Code name (`readExplorerView`). A file missing, unparseable or oddly shaped is no
 *  commands and the default view. The watcher reports every write of it as `commands:changed`. */
export const PROJECT_FILE = "tet.json";

/** A plain string while the command line says everything, an object once it needs name, cwd, env or
 *  shell. `"shell": true` hands the line to `AgentDefinition.runArgs`, so it only works where it was
 *  written. */
type StoredCommand =
  | string
  | { command?: unknown; name?: unknown; cwd?: unknown; env?: unknown; shell?: unknown };

interface ProjectFile {
  commands?: StoredCommand[];
  folders?: unknown;
  settings?: unknown;
  /** The sbx-settings dialog's state (readSbxConfig/writeSbxConfig). Never a credential. */
  sbx?: unknown;
}

/** The view settings' keys inside `settings`, as VS Code spells them. */
const KEY_EXCLUDE = "files.exclude";
const KEY_EXCLUDE_GIT_IGNORE = "explorer.excludeGitIgnore";
const KEY_COMPACT_FOLDERS = "explorer.compactFolders";
const KEY_SORT_ORDER = "explorer.sortOrder";

/** How the Explorer shows this project; anything of the wrong shape is its default. */
export interface ExplorerView {
  /** Top-level nodes; empty means the whole repository as one tree. They may overlap, each file is
   *  still listed once. A `name` is file-only: the tree's menu writes paths alone. */
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

/** `read`'s answer for a file that doesn't parse; `patch` must never write over it. */
const UNREADABLE: ProjectFile = {};

function file(root: string): string {
  return path.join(root, PROJECT_FILE);
}

/** The file's text, or **null** when there is none. */
async function readText(root: string): Promise<string | null> {
  try {
    return await fs.readFile(file(root), "utf8");
  } catch {
    return null;
  }
}

/** Parsed like a `.code-workspace`: comments and trailing commas allowed. */
function parse(text: string): ProjectFile {
  const errors: ParseError[] = [];
  const content: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  return errors.length > 0 || typeof content !== "object" || content === null || Array.isArray(content)
    ? UNREADABLE
    : (content as ProjectFile);
}

/** The file's contents, or **null** when there is none. A write may create a missing file but never
 *  replaces a broken one — it is a file in the user's repository. */
async function read(root: string): Promise<ProjectFile | null> {
  const text = await readText(root);
  return text === null ? null : parse(text);
}

/** A value to set at a path inside the file; undefined removes the key. */
type Change = [JSONPath, unknown];

/**
 * Applies the changes `edit` derives from the file's contents, leaving comments, formatting and
 * every other key as the user wrote them; throws on a broken file rather than have it written over.
 */
async function patch(root: string, edit: (content: ProjectFile) => Change[]): Promise<void> {
  const text = await readText(root);
  const content = text === null ? {} : parse(text);
  if (content === UNREADABLE) {
    throw new Error(`${PROJECT_FILE} is not valid JSON`);
  }
  const changes = edit(content);
  if (changes.length === 0) {
    return;
  }
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text?.includes("\r\n") ? "\r\n" : "\n" };
  let next = text ?? "";
  for (const [jsonPath, value] of changes) {
    next = applyEdits(next, modify(next, jsonPath, value, { formattingOptions }));
  }
  await writeFileAtomic(file(root), text === null ? `${next}\n` : next, "utf8");
}

/** Only the string values of an `env`, which outranks the inherited environment. */
function toEnv(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const env = Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string")
  );
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Both spellings in, one shape out; anything else is dropped. */
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

/** In the array's order, which is the screen order. */
export async function readCommands(root: string): Promise<ProjectCommand[]> {
  const content = await read(root);
  if (!content || !Array.isArray(content.commands)) {
    return [];
  }
  return content.commands.map(toCommand).filter((command): command is ProjectCommand => command !== undefined);
}

export function writeCommands(root: string, commands: ProjectCommand[]): Promise<void> {
  // The short form wherever the command line alone says it all.
  return patch(root, () => [
    [
      ["commands"],
      commands.map((command) => (command.name || command.cwd || command.env || command.shell ? command : command.command))
    ]
  ]);
}

/** A `folders` path as the tree keys it: repository-relative, forward slashes, "" for the root;
 *  undefined (skipped) for anything outside the repository. */
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

/** A stored entry's path — `{ path }` or, tolerated, a bare string. */
function storedPath(entry: unknown): string | undefined {
  return toFolderPath(typeof entry === "string" ? entry : (entry as { path?: unknown } | null)?.path);
}

/** `folders` as roots; a duplicate path is one root. */
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

/** Any nested object of tet.json; anything not a plain object is an empty one. */
function toSettings(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `files.exclude`: VS Code's map of glob → true; only `true` counts. */
function toExclude(value: unknown): string[] {
  return Object.entries(toSettings(value))
    .filter(([pattern, enabled]) => enabled === true && pattern.trim())
    .map(([pattern]) => pattern);
}

export async function readExplorerView(root: string): Promise<ExplorerView> {
  const content = (await read(root)) ?? {};
  const settings = toSettings(content.settings);
  return {
    folders: toFolders(content.folders, root),
    exclude: toExclude(settings[KEY_EXCLUDE]),
    excludeGitIgnore: booleanOr(settings[KEY_EXCLUDE_GIT_IGNORE], DEFAULT_EXPLORER_VIEW.excludeGitIgnore),
    compactFolders: booleanOr(settings[KEY_COMPACT_FOLDERS], DEFAULT_EXPLORER_VIEW.compactFolders),
    sortOrder: SORT_ORDERS.find((order) => order === settings[KEY_SORT_ORDER]) ?? DEFAULT_EXPLORER_VIEW.sortOrder
  };
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** `readExplorerView`'s defaults, and ipc.ts's for a missing repository. */
export const DEFAULT_EXPLORER_VIEW: ExplorerSettings = {
  excludeGitIgnore: false,
  compactFolders: true,
  sortOrder: "default"
};

/** "Add Folder to Workspace". No `folders` means the whole repository, so the first add also writes
 *  that root. Existing entries are kept as written. */
export function addFolder(root: string, folderPath: string): Promise<void> {
  return patch(root, (content) => {
    const folders = Array.isArray(content.folders) ? (content.folders as unknown[]) : [];
    if (folders.some((entry) => storedPath(entry) === folderPath)) {
      return [];
    }
    const kept = folders.length === 0 ? [{ path: "." }] : folders;
    return [[["folders"], [...kept, { path: folderPath }]]];
  });
}

/** "Remove Folder from Workspace": the last one gone means no `folders` — the whole repository. */
export function removeFolder(root: string, folderPath: string): Promise<void> {
  return patch(root, (content) => {
    const folders = (Array.isArray(content.folders) ? (content.folders as unknown[]) : []).filter(
      (entry) => storedPath(entry) !== folderPath
    );
    return [[["folders"], folders.length > 0 ? folders : undefined]];
  });
}

/** Writes one key inside `settings`, keeping every other key. */
function patchSetting(root: string, key: string, value: unknown): Promise<void> {
  return patch(root, (content) => [settingChange(content, key, value)]);
}

/** A key inside `settings`; a `settings` that isn't an object is replaced, as an edit can't reach into it. */
function settingChange(content: ProjectFile, key: string, value: unknown): Change {
  const settings = content.settings;
  return typeof settings === "object" && settings !== null && !Array.isArray(settings)
    ? [["settings", key], value]
    : [["settings"], { [key]: value }];
}

/** "Exclude from Files": the path itself as a pattern, set to true. */
export function addExclude(root: string, relPath: string): Promise<void> {
  return patch(root, (content) => {
    const exclude = toSettings(content.settings)[KEY_EXCLUDE];
    return [
      typeof exclude === "object" && exclude !== null && !Array.isArray(exclude)
        ? [["settings", KEY_EXCLUDE, relPath], true]
        : settingChange(content, KEY_EXCLUDE, { [relPath]: true })
    ];
  });
}

const EXPLORER_SETTING_KEYS: Record<keyof ExplorerSettings, string> = {
  excludeGitIgnore: KEY_EXCLUDE_GIT_IGNORE,
  compactFolders: KEY_COMPACT_FOLDERS,
  sortOrder: KEY_SORT_ORDER
};

/** The three file-only view settings, set from the settings dialog's Files tab. */
export async function setExplorerSetting<K extends keyof ExplorerSettings>(
  root: string,
  key: K,
  value: ExplorerSettings[K]
): Promise<void> {
  await patchSetting(root, EXPLORER_SETTING_KEYS[key], value);
}

const SBX_ACCESS: readonly SbxAccess[] = ["ro", "rw"];

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

/** Trimmed: sbx validates nothing, so a stray space becomes a rule that matches no request. */
function toSbxHosts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

/** An allowed-path row plus, outside the home, the platform it was entered on: an absolute path
 *  means nothing on another OS, so readSbxConfig reads and writeSbxConfig replaces only this
 *  platform's rows. A `~/…` row carries no `os` and applies everywhere. */
interface StoredSbxPath extends SbxPath {
  os?: string;
}

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
      const row: StoredSbxPath = { path: hostPath, access: SBX_ACCESS.find((candidate) => candidate === access) ?? "rw" };
      if (typeof os === "string") {
        row.os = os;
      }
      paths.push(row);
    }
  }
  return paths;
}

function sbxSection(content: ProjectFile): Record<string, unknown> {
  return toSettings(content.sbx);
}

/** A malformed or missing `knowledge` object reads as every kind off, never partially on. */
function toSbxKnowledge(value: unknown): SbxKnowledgeConfig {
  const record = toSettings(value);
  const toAccess = (field: unknown): SbxAccess | false => SBX_ACCESS.find((candidate) => candidate === field) ?? false;
  return { skills: toAccess(record.skills), plugins: toAccess(record.plugins), instructions: toAccess(record.instructions) };
}

/** The sbx settings: ports, allowed paths (a folder or a single file), hosts, and which of the
 *  agent's skills, plugins and instructions to mount. Never holds a token: each sandboxed agent
 *  signs in with its own `/login` inside the sandbox. */
export async function readSbxConfig(root: string): Promise<SbxProjectConfig> {
  const sbx = sbxSection((await read(root)) ?? {});
  const paths = toSbxPaths(sbx.paths)
    .filter(appliesHere)
    .map(({ path: hostPath, access }) => ({ path: hostPath, access }));
  return {
    enabled: sbx.enabled === true,
    knowledge: toSbxKnowledge(sbx.knowledge),
    ports: toSbxPorts(sbx.ports),
    paths,
    hosts: toSbxHosts(sbx.hosts)
  };
}

/** Replaces only the rows that apply here — see StoredSbxPath. */
export function writeSbxConfig(root: string, config: SbxProjectConfig): Promise<void> {
  return patch(root, (content) => {
    const others = toSbxPaths(sbxSection(content).paths).filter((entry) => !appliesHere(entry));
    const mine = config.paths.map((entry): StoredSbxPath => (entry.path.startsWith("~") ? entry : { ...entry, os: process.platform }));
    return [
      [
        ["sbx"],
        {
          enabled: config.enabled,
          knowledge: config.knowledge,
          ports: config.ports,
          paths: [...others, ...mine],
          hosts: config.hosts
        }
      ]
    ];
  });
}
