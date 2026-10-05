import * as fs from "node:fs/promises";
import * as path from "node:path";
// The ESM build: esbuild can't follow the UMD build's `require("./impl/format")`.
import { applyEdits, modify, parse as parseJsonc, type JSONPath, type ParseError } from "jsonc-parser/lib/esm/main.js";
import writeFileAtomic from "write-file-atomic";
import { isEnvName, isReservedName } from "../../shared/env-rules";
import { errorMessage } from "../../shared/errors";
import { COMMAND_COLORS } from "../../shared/types/project";
import { SBX_ACCESS } from "../../shared/types/sbx";
import type { ExplorerRoot } from "../../shared/types/files";
import type { CommandColor, ProjectCommand } from "../../shared/types/project";
import type { SbxPath, SbxPort, SbxProjectSettings, SbxSecret, SbxVariable } from "../../shared/types/sbx";
import { machineName } from "./env-names";
import { readRepositoryPath } from "../util/linked-git-dir";
import { inTurn } from "../util/async";
import { isRecord } from "../util/json-file";
import { PLATFORM } from "../util/host-platform";

/** A project's saved commands, Explorer folders and excludes and SBX settings, in its own root so
 *  it travels with the repository; a linked worktree has none of its own (configRoot). The
 *  Explorer's `folders` and `exclude` list lie at the top (`readExplorerView`). A file missing or
 *  oddly shaped is no commands and the default view; a broken one its last readable version
 *  (`read`). The watcher reports every write of it as `commands:changed`. */
export const PROJECT_FILE = "tet.json";

/** A plain string while the command line says everything, an object once it needs name, cwd, env or
 *  shell. `"shell": true` hands the line to `AgentDefinition.run`, so it only works where it was
 *  written. */
type StoredCommand = string | { command?: unknown; name?: unknown; color?: unknown; cwd?: unknown; env?: unknown; shell?: unknown };

interface ProjectFile {
  commands?: StoredCommand[];
  folders?: unknown;
  exclude?: unknown;
  /** The sbx-settings dialog's state (readSbxSettings/writeSbxSettings). Never a credential. */
  sbx?: unknown;
}

/** What of the Explorer's view is the project's; anything of the wrong shape is its default. */
export interface ExplorerView {
  /** Top-level nodes; empty means the whole repository as one tree. They may overlap, each file is
   *  still listed once. A `name` is file-only: the tree's menu writes paths alone. */
  folders: ExplorerRoot[];
  /** The `exclude` list's globs, matched against repository-relative paths. */
  exclude: string[];
}

/** Where a project's tet.json lives: a linked worktree takes its repository's, read and never
 *  written from the worktree. The copy git checks out in the worktree is ignored. Resolved once per
 *  public call and handed down: each resolution reads the `.git` file and resolves a real path. */
export function configRoot(root: string): string {
  return readRepositoryPath(root) ?? root;
}

function file(root: string): string {
  return path.join(configRoot(root), PROJECT_FILE);
}

/**
 * The file as it is on disk: its text and contents — both null where there is none, or only
 * whitespace — or why it cannot be used. Parsed like a `.code-workspace`: comments and trailing
 * commas allowed. A file there but unreadable for the moment (EPERM while another process renames
 * over it on win32) is broken, not missing, which `patch` would write over.
 */
async function readNow(filePath: string): Promise<{ text: string | null; content: ProjectFile | null } | { problem: string }> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: null, content: null };
    }
    return { problem: `${PROJECT_FILE} could not be read: ${errorMessage(error)}` };
  }
  if (text.trim() === "") {
    return { text: null, content: null };
  }
  const errors: ParseError[] = [];
  const content: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  return errors.length > 0 || !isRecord(content) ? { problem: `${PROJECT_FILE} is not valid JSON` } : { text, content };
}

/** Each file's contents as last read whole: what it counts as while broken (`read`). */
const lastReadable = new Map<string, ProjectFile | null>();

/**
 * Why the project's tet.json cannot be used, or nothing, keeping it as the last readable when it
 * can. Asked before a project opens — one whose file is broken is not opened (projects.ts) — and
 * after each write of it, so a project always has a last readable version while it is open.
 */
export function tetJsonProblem(root: string): Promise<string | undefined> {
  return problemAt(file(root));
}

async function problemAt(filePath: string): Promise<string | undefined> {
  const reading = await readNow(filePath);
  if ("problem" in reading) {
    return reading.problem;
  }
  lastReadable.set(filePath, reading.content);
  return undefined;
}

/**
 * A write of the repository's file, as its watcher reports it, read once for every listener: why it
 * cannot be used, and its commands and SBX settings — its last readable version's while broken,
 * none where it never was readable.
 */
export async function readChanged(
  root: string,
): Promise<{ problem: string | undefined; commands?: ProjectCommand[]; sbx?: SbxProjectSettings }> {
  const own = configRoot(root);
  const filePath = path.join(own, PROJECT_FILE);
  const problem = await problemAt(filePath);
  const content = lastReadable.get(filePath);
  return content === undefined ? { problem } : { problem, commands: toCommands(content), sbx: toSbxSettings(content, own !== root) };
}

/** The file's contents, or **null** when there is none. A broken file counts as its last readable
 *  version, never as none: an sbx project would run its agents on this machine. */
async function read(filePath: string): Promise<ProjectFile | null> {
  const problem = await problemAt(filePath);
  const last = lastReadable.get(filePath);
  if (last === undefined) {
    throw new Error(problem);
  }
  return last;
}

/** A value to set at a path inside the file; undefined removes the key. `insert` puts it into the
 *  array at the index the path ends in instead, leaving the array's other entries as written. */
type Change = [JSONPath, unknown, insert?: true];

/** The patch underway per file: commands, the Explorer menu, the SBX Settings and tet-ctl all write
 *  it, and two read-modify-writes at once keep only the last one's change. */
const patches = new Map<string, Promise<unknown>>();

/**
 * Applies the changes `edit` derives from the file's contents, leaving comments, formatting and
 * every other key as the user wrote them; throws on a broken file rather than have it written over.
 * One at a time per file, each after the last however that one ended.
 */
function patch(root: string, edit: (content: ProjectFile) => Change[]): Promise<void> {
  const own = configRoot(root);
  const key = path.join(own, PROJECT_FILE);
  return inTurn(patches, key, () => patchNow(root, own, key, edit));
}

/** Throws for a worktree (`own`, its config root, is another folder): everything that changes its
 *  settings changes its repository's, there. */
async function patchNow(root: string, own: string, filePath: string, edit: (content: ProjectFile) => Change[]): Promise<void> {
  if (own !== root) {
    throw new Error(`A worktree takes its settings from ${path.basename(own)}: change them there`);
  }
  const reading = await readNow(filePath);
  if ("problem" in reading) {
    throw new Error(reading.problem);
  }
  const { text } = reading;
  const changes = edit(reading.content ?? {});
  if (changes.length === 0) {
    return;
  }
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text?.includes("\r\n") ? "\r\n" : "\n" };
  let next = text ?? "";
  for (const [jsonPath, value, insert] of changes) {
    next = applyEdits(next, modify(next, jsonPath, value, { formattingOptions, isArrayInsertion: insert }));
  }
  await writeFileAtomic(filePath, text === null ? `${next}\n` : next, "utf8");
}

/** Only the string values of an `env`, which outranks the inherited environment — but for the names
 *  TET sets itself (isReservedName): tet-ctl's PATH and its control channel. */
function toEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const env = Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string" && !isReservedName(pair[0])),
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
  const color = COMMAND_COLORS.find((candidate): candidate is CommandColor => candidate === entry.color);
  if (color) {
    command.color = color;
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
  return toCommands(await read(file(root)));
}

function toCommands(content: ProjectFile | null): ProjectCommand[] {
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
      commands.map((command) => (command.name || command.color || command.cwd || command.env || command.shell ? command : command.command)),
    ],
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
    const stored = isRecord(entry) ? entry.name : undefined;
    const name = typeof stored === "string" ? stored.trim() : "";
    folders.push({ path: folderPath, name: name || path.basename(folderPath || path.resolve(root)) });
  }
  return folders;
}

/** Any nested object of tet.json; anything not a plain object is an empty one. */
function toSettings(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** `exclude`: a list of globs; an entry that isn't a non-blank string is no pattern. */
function toExclude(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((pattern): pattern is string => typeof pattern === "string" && pattern.trim() !== "") : [];
}

export async function readExplorerView(root: string): Promise<ExplorerView> {
  const content = (await read(file(root))) ?? {};
  return { folders: toFolders(content.folders, root), exclude: toExclude(content.exclude) };
}

/** "Add Folder to Explorer". No `folders` means the whole repository, so the first add also writes
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

/** "Remove Folder from Explorer": the last one gone means no `folders` — the whole repository. */
export function removeFolder(root: string, folderPath: string): Promise<void> {
  return patch(root, (content) => {
    const folders = (Array.isArray(content.folders) ? (content.folders as unknown[]) : []).filter(
      (entry) => storedPath(entry) !== folderPath,
    );
    return [[["folders"], folders.length > 0 ? folders : undefined]];
  });
}

/** "Exclude from Explorer": the path itself as a pattern, appended unless listed; a stored
 *  `exclude` that isn't a list is replaced, as an edit can't reach into it. */
export function addExclude(root: string, relPath: string): Promise<void> {
  return patch(root, (content) => {
    if (!Array.isArray(content.exclude)) {
      return [[["exclude"], [relPath]]];
    }
    return content.exclude.includes(relPath) ? [] : [[["exclude", content.exclude.length], relPath, true]];
  });
}

/**
 * The object entries of a stored array, each handed to `row`; a non-array, and an entry that is
 * not an object, is nothing. `row` answers undefined for a row it will not take — every list in
 * tet.json is read this defensively (see the file header).
 */
function objectRows<T>(value: unknown, row: (entry: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: T[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const taken = row(entry);
    if (taken !== undefined) {
      rows.push(taken);
    }
  }
  return rows;
}

function toSbxPorts(value: unknown): SbxPort[] {
  return objectRows(value, ({ host, container }) =>
    typeof host === "string" && typeof container === "string" && host.trim() && container.trim() ? { host, container } : undefined,
  );
}

/** Trimmed as sbx trims them itself, so a row equals the rule sbx lists for it (sbx-save.ts's
 *  readSandboxHosts). */
function toSbxHosts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** A row needs an env name and a host; hosts trimmed as toSbxHosts, a repeated env name dropped —
 *  sbx refuses a second secret for one. */
function toSbxSecrets(value: unknown): SbxSecret[] {
  const secrets = objectRows(value, ({ env, hosts }) => {
    const name = typeof env === "string" ? env.trim() : "";
    const trimmedHosts = toSbxHosts(hosts);
    return name && trimmedHosts.length > 0 ? { env: name, hosts: trimmedHosts } : undefined;
  });
  // A repeated env name keeps the first row only.
  return secrets.filter((secret, i) => secrets.findIndex((other) => other.env === secret.env) === i);
}

/** A row needs an env name, trimmed; a repeated one (on win32 in any case, as the environment
 *  `sbx run -e NAME` reads it from), one a secret already holds, or one of TET's own dropped — the
 *  sandbox sees one value per name, and a secret's is its placeholder (sbx.ts's sandboxEnv). */
function toSbxVariables(value: unknown, secrets: SbxSecret[]): SbxVariable[] {
  const variables = objectRows(value, ({ env }) => {
    const name = typeof env === "string" ? env.trim() : "";
    return isEnvName(name) && !isReservedName(name) && !secrets.some((secret) => secret.env === name) ? { env: name } : undefined;
  });
  // A repeated env name keeps the first row only.
  return variables.filter((variable, i) => variables.findIndex((other) => machineName(other.env) === machineName(variable.env)) === i);
}

/** An allowed-path row plus, outside the home, the platform it was entered on: an absolute path
 *  means nothing on another OS, so readSbxSettings reads and writeSbxSettings replaces only this
 *  platform's rows. A `~/…` row carries no `os` and applies everywhere. */
interface StoredSbxPath extends SbxPath {
  os?: string;
}

function appliesHere(entry: StoredSbxPath): boolean {
  return entry.os === undefined || entry.os === PLATFORM.id;
}

function toSbxPaths(value: unknown): StoredSbxPath[] {
  return objectRows(value, ({ path: hostPath, access, os }) => {
    if (typeof hostPath !== "string" || !hostPath.trim()) {
      return undefined;
    }
    const row: StoredSbxPath = { path: hostPath, access: SBX_ACCESS.find((candidate) => candidate === access) ?? "rw" };
    if (typeof os === "string") {
      row.os = os;
    }
    return row;
  });
}

function sbxSection(content: ProjectFile): Record<string, unknown> {
  return toSettings(content.sbx);
}

/** The SBX settings: ports, allowed paths (a folder or a single file), hosts, the secrets' names and
 *  hosts and the variables' names. Never holds a token: each sandboxed agent signs in with its own
 *  `/login` inside the sandbox, and a secret's or variable's value stays on this machine, as does
 *  the knowledge (sbx-local.ts). A worktree forwards no ports: a port of this machine reaches one
 *  sandbox, and its repository's has it. */
export async function readSbxSettings(root: string): Promise<SbxProjectSettings> {
  const own = configRoot(root);
  return toSbxSettings(await read(path.join(own, PROJECT_FILE)), own !== root);
}

function toSbxSettings(content: ProjectFile | null, worktree: boolean): SbxProjectSettings {
  const sbx = sbxSection(content ?? {});
  const paths = toSbxPaths(sbx.paths)
    .filter(appliesHere)
    .map(({ path: hostPath, access }) => ({ path: hostPath, access }));
  const secrets = toSbxSecrets(sbx.secrets);
  return {
    enabled: sbx.enabled === true,
    ports: worktree ? [] : toSbxPorts(sbx.ports),
    paths,
    hosts: toSbxHosts(sbx.hosts),
    secrets,
    variables: toSbxVariables(sbx.variables, secrets),
  };
}

/** Replaces only the rows that apply here — see StoredSbxPath. */
export function writeSbxSettings(root: string, config: SbxProjectSettings): Promise<void> {
  return patch(root, (content) => {
    const others = toSbxPaths(sbxSection(content).paths).filter((entry) => !appliesHere(entry));
    const mine = config.paths.map((entry): StoredSbxPath => (entry.path.startsWith("~") ? entry : { ...entry, os: PLATFORM.id }));
    return [
      [
        ["sbx"],
        {
          enabled: config.enabled,
          ports: config.ports,
          paths: [...others, ...mine],
          hosts: config.hosts,
          secrets: config.secrets,
          variables: config.variables,
        },
      ],
    ];
  });
}
