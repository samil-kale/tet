/**
 * What an SBX Settings row may be, what its edits reach, and how a problem with it is worded — one
 * rule for the dialog's marks (src/renderer/dialogs/SbxSettingsFields.tsx), the control channel's
 * `sbx-set-*` verbs and a sandboxed session's start (sbx.ts's readSbxProblems).
 */

import { envNameKey, isEnvName, isReservedName } from "./env-rules";
import { ownValue } from "./own-value";
import { isHttpUrl } from "./url";
import type {
  SbxSkillsSettings,
  SbxSkillsKind,
  SbxLocalEdits,
  SbxMcpServer,
  SbxOption,
  SbxPort,
  SbxProblems,
  SbxProjectSettings,
  SbxVariable,
} from "./types/sbx";

/** Every kind of skills, in the Skills tab's order. */
export const SBX_SKILLS_KINDS: SbxSkillsKind[] = ["skills", "instructions"];

/** What `sbx ports --publish` and `sbx run -p` take: a whole number from 1 to 65535. */
export function isPort(value: string): boolean {
  const trimmed = value.trim();
  return /^\d{1,5}$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= 65535;
}

/** Why a port row cannot be saved, or undefined. */
export function sbxPortRefusal({ host, container }: SbxPort): string | undefined {
  return isPort(host) && isPort(container) ? undefined : "Both ports must be whole numbers from 1 to 65535";
}

/**
 * Why a variable row cannot be saved beside the `others`, or undefined: it needs a name no other
 * variable holds — the sandbox sees one value per name, and `sbx run -e NAME` reads a variable's
 * from this machine's environment, which on win32 ignores case (`ignoreCase`, the machine's) — and
 * not one of TET's own (isReservedName): its value is set on `sbx run` itself (sbx.ts's sandboxEnv).
 */
export function sbxVariableRefusal({ env }: SbxVariable, others: SbxVariable[], ignoreCase: boolean): string | undefined {
  const same = (name: string): string => envNameKey(name, ignoreCase);
  return !isEnvName(env) || isReservedName(env) || others.some((other) => same(other.env) === same(env))
    ? "Needs a variable name no other variable holds, not PATH or TET_*"
    : undefined;
}

/** sbx's own image references, the one form `sbx mcp add --url` takes without a scheme. */
const MCP_IMAGE_PREFIX = "dhi.io/";

/**
 * A server's row: one per name, as sbx has one server per name, and a URL sbx can register it from
 * — an http(s) one or an image of sbx's own registry; none for a server it has registered already.
 * What sbx then makes of the URL is its own answer at Save.
 */
export function sbxMcpRefusal({ name, url }: SbxMcpServer, others: SbxMcpServer[]): string | undefined {
  if (others.some((other) => other.name.trim() === name.trim())) {
    return "Needs a name no other server holds";
  }
  const source = url.trim();
  return source === "" || isHttpUrl(source) || (source.startsWith(MCP_IMAGE_PREFIX) && !/\s/.test(source))
    ? undefined
    : "Needs a URL starting with https:// or http://";
}

/** Whether two URLs are one server's, as sbx stores a registration: apart from a trailing slash. */
export function sameMcpUrl(first: string, second: string): boolean {
  const bare = (url: string): string => url.trim().replace(/\/+$/, "");
  return bare(first) === bare(second);
}

/**
 * Whether going from `loaded` and `loadedSkills` to `settings` and `skills` reaches a running
 * tab only once it restarts: a mount is added at a tab's start (a removed one goes at Save), and
 * `sbx run -e` sets a variable only there (sbx.ts's prepareSbxRun), as a changed setup script runs
 * there. Ports and hosts apply at Save; an emptied setup script applies to nothing.
 */
export function sbxNeedsRestart(
  loaded: SbxProjectSettings,
  loadedSkills: SbxSkillsSettings,
  settings: Omit<SbxProjectSettings, "enabled">,
  skills: SbxSkillsSettings,
): boolean {
  const names = (variables: SbxProjectSettings["variables"]): string => JSON.stringify(variables.map((variable) => variable.env).sort());
  return (
    SBX_SKILLS_KINDS.some((kind) => skills[kind] !== false && skills[kind] !== loadedSkills[kind]) ||
    (skills.skills !== false && skills.skillsFolder !== loadedSkills.skillsFolder) ||
    settings.paths.some((entry) => !loaded.paths.some((old) => old.path === entry.path && old.access === entry.access)) ||
    names(settings.variables) !== names(loaded.variables) ||
    (settings.setup.length > 0 && settings.setup.join("\n") !== loaded.setup.join("\n"))
  );
}

/** What is wrong with a row that cannot be applied (SbxProblems), besides the policy's no
 *  (forbiddenBy) and what sbx said on refusing it. */
export const SBX_PROBLEM = {
  missing: "Does not exist on this machine",
  noValue: "No value on this machine",
  portInUse: "In use on this machine",
  refused: "Refused by sbx",
  notStarted: "Its sandbox could not be started",
  hostsUnlisted: "sbx did not list the sandbox's allowed hosts",
  mcpUnlisted: "sbx did not list its registered MCP servers",
  mcpOtherUrl: "Already registered with sbx under another URL",
  mcpUnregistered: "Not registered with sbx, and no URL to register it with",
  failed: "Tried again at the next start",
} as const;

/** A setup script's text as its lines (SbxProjectSettings.setup): each without trailing
 *  whitespace, blank lines dropped at either end. */
export function setupLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  while (lines[0] === "") {
    lines.shift();
  }
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** The policy's no: under governance the organization's, else sbx's own. */
export function forbiddenBy(organization: string | undefined): string {
  return organization ? "Forbidden by governance" : "Forbidden by SBX's policy";
}

/** In the dialog's tab order. */
const SBX_OPTIONS: SbxOption[] = ["skills", "ports", "paths", "hosts", "mcp", "variables", "setup"];

/**
 * What a sandboxed session's start could not apply, one notice per option and reason, its rows
 * listed:
 *
 *   Could not set hosts:
 *    - api.example.com
 *   Forbidden by governance
 *
 * The setup script is run, not set; its row is the last line it printed to stderr.
 */
export function sbxProblemNotices(problems: SbxProblems): string[] {
  return SBX_OPTIONS.flatMap((option) => {
    const rows = Object.entries(problems[option] ?? {});
    const reasons = [...new Set(rows.map(([, reason]) => reason))];
    return reasons.map((reason) =>
      [
        `Could not ${option === "setup" ? "run" : "set"} ${option}:`,
        ...rows.filter(([, why]) => why === reason).map(([row]) => ` - ${row}`),
        reason,
      ].join("\n"),
    );
  });
}

/** What is wrong with `row` of `option`, undefined where nothing is. */
export function problemOf(problems: SbxProblems, option: SbxOption, row: string): string | undefined {
  return ownValue(problems[option] ?? {}, row);
}

/** Adds `rows` (by row, with their reason) to `problems` under `option`. */
export function addProblems(problems: SbxProblems, option: SbxOption, rows: Record<string, string>): void {
  if (Object.keys(rows).length > 0) {
    problems[option] = { ...problems[option], ...rows };
  }
}

/** Adds every option's rows of `from` to `problems` (addProblems). */
export function mergeProblems(problems: SbxProblems, from: SbxProblems): void {
  for (const [option, rows] of Object.entries(from) as [SbxOption, Record<string, string>][]) {
    addProblems(problems, option, rows);
  }
}

/** A list's edits that type no value and keep each row's stored one (SbxLocalEdits): a Save that
 *  changes no value, of rows under their stored names. */
export function keptValues(rows: { env: string }[]): SbxLocalEdits {
  return { values: {}, from: Object.fromEntries(rows.map(({ env }) => [env, env])) };
}

/** A port row's key in SbxProblems, as `sbx ports` takes it. */
export function sbxPortKey(port: SbxPort): string {
  return `${port.host}:${port.container}`;
}

/** What is saved and applied: the rows readSbxProblems found nothing wrong with, a kind of
 *  skills with a problem off. */
export function withoutProblems(
  settings: SbxProjectSettings,
  skills: SbxSkillsSettings,
  problems: SbxProblems,
): { settings: SbxProjectSettings; skills: SbxSkillsSettings } {
  const fine = (option: SbxOption, row: string): boolean => problemOf(problems, option, row) === undefined;
  const next = { ...skills };
  for (const kind of SBX_SKILLS_KINDS.filter((candidate) => !fine("skills", candidate))) {
    next[kind] = false;
  }
  return {
    settings: {
      ...settings,
      ports: settings.ports.filter((port) => fine("ports", sbxPortKey(port))),
      paths: settings.paths.filter((entry) => fine("paths", entry.path)),
      hosts: settings.hosts.filter((host) => fine("hosts", host)),
      variables: settings.variables.filter((variable) => fine("variables", variable.env)),
      mcp: settings.mcp.filter((server) => fine("mcp", server.name)),
    },
    skills: next,
  };
}
