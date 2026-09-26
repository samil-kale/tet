/**
 * What an SBX Settings row may be, what its edits reach, and how a problem with it is worded — one
 * rule for the dialog's marks (src/renderer/dialogs/SbxSettingsFields.tsx), the control channel's
 * `sbx-set-*` verbs and a sandboxed session's start (sbx.ts's readSbxProblems).
 */

import { isEnvName, isReservedName } from "./env-rules";
import type {
  SbxKnowledgeConfig,
  SbxKnowledgeKind,
  SbxLocalEdits,
  SbxOption,
  SbxPort,
  SbxProblems,
  SbxProjectConfig,
  SbxSecret,
  SbxVariable
} from "./types";

/** Every kind of knowledge, in the Knowledge tab's order. */
export const SBX_KNOWLEDGE_KINDS: SbxKnowledgeKind[] = ["skills", "plugins", "instructions"];

/** What `sbx ports --publish` and `sbx run -p` take: a whole number from 1 to 65535. */
export function isPort(value: string): boolean {
  const trimmed = value.trim();
  return /^\d{1,5}$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= 65535;
}

/** A scheme or port, which `sbx secret set-custom` rejects, or a leading "-", which sbx would read
 *  as an option of its own. */
function isBadHost(host: string): boolean {
  return /^-|[/:]/.test(host);
}

/** Why a port row cannot be saved, or undefined. */
export function sbxPortRefusal({ host, container }: SbxPort): string | undefined {
  return isPort(host) && isPort(container) ? undefined : "Both ports must be whole numbers from 1 to 65535";
}

/** Why a secret row cannot be saved beside the `others`, or undefined: it needs a variable name of
 *  its own and hosts, none with a scheme or port (isBadHost). */
export function sbxSecretRefusal({ env, hosts }: SbxSecret, others: SbxSecret[]): string | undefined {
  return !isEnvName(env) || others.some((other) => other.env === env) || hosts.length === 0 || hosts.some(isBadHost)
    ? "Needs a variable name of its own and hosts without scheme or port"
    : undefined;
}

/**
 * Why a variable row cannot be saved beside the `others` and the secrets, or undefined: it needs a
 * name no secret or other variable holds — the sandbox sees one value per name, and `sbx run -e
 * NAME` reads a variable's from this machine's environment, which on win32 ignores case
 * (`ignoreCase`, the machine's) — and not one of tet's own (isReservedName): its value is set on
 * `sbx run` itself (sbx.ts's sandboxEnv).
 */
export function sbxVariableRefusal(
  { env }: SbxVariable,
  others: SbxVariable[],
  secrets: SbxSecret[],
  ignoreCase: boolean
): string | undefined {
  const same = (name: string): string => (ignoreCase ? name.toUpperCase() : name);
  return !isEnvName(env) ||
    isReservedName(env) ||
    others.some((other) => same(other.env) === same(env)) ||
    secrets.some((secret) => secret.env === env)
    ? "Needs a variable name no secret or other variable holds, not PATH or TET_*"
    : undefined;
}

/**
 * Whether going from `loaded` and `loadedKnowledge` to `config` and `knowledge` reaches a running
 * tab only once it restarts: a mount is added at a tab's start (a removed one goes at Save), and
 * `sbx run -e` sets a variable, a new secret's placeholder included, only there (sbx.ts's
 * prepareSbxRun). Ports, hosts and a secret's value or hosts apply at Save.
 */
export function sbxNeedsRestart(
  loaded: SbxProjectConfig,
  loadedKnowledge: SbxKnowledgeConfig,
  config: Omit<SbxProjectConfig, "enabled">,
  knowledge: SbxKnowledgeConfig
): boolean {
  const names = (variables: SbxProjectConfig["variables"]): string => JSON.stringify(variables.map((variable) => variable.env).sort());
  return (
    SBX_KNOWLEDGE_KINDS.some((kind) => knowledge[kind] !== false && knowledge[kind] !== loadedKnowledge[kind]) ||
    (knowledge.skills !== false && knowledge.skillsFolder !== loadedKnowledge.skillsFolder) ||
    config.paths.some((entry) => !loaded.paths.some((old) => old.path === entry.path && old.access === entry.access)) ||
    config.secrets.some((secret) => !loaded.secrets.some((old) => old.env === secret.env)) ||
    names(config.variables) !== names(loaded.variables)
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
  secretsUnlisted: "sbx did not list the sandbox's secrets",
  hostsUnlisted: "sbx did not list the sandbox's allowed hosts"
} as const;

/** The policy's no: under governance the organization's, else sbx's own. */
export function forbiddenBy(organization: string | undefined): string {
  return organization ? "Forbidden by governance" : "Forbidden by SBX's policy";
}

/** In the dialog's tab order. */
const SBX_OPTIONS: SbxOption[] = ["knowledge", "ports", "paths", "hosts", "secrets", "variables"];

/**
 * What a sandboxed session's start could not apply, one notice per option and reason, its rows
 * listed:
 *
 *   Couldn't set hosts:
 *    - api.example.com
 *   Forbidden by governance
 */
export function sbxProblemNotices(problems: SbxProblems): string[] {
  return SBX_OPTIONS.flatMap((option) => {
    const rows = Object.entries(problems[option] ?? {});
    const reasons = [...new Set(rows.map(([, reason]) => reason))];
    return reasons.map((reason) =>
      [`Couldn't set ${option}:`, ...rows.filter(([, why]) => why === reason).map(([row]) => ` - ${row}`), reason].join("\n")
    );
  });
}

/** Adds `rows` (by row, with their reason) to `problems` under `option`. */
export function addProblems(problems: SbxProblems, option: SbxOption, rows: Record<string, string>): void {
  if (Object.keys(rows).length > 0) {
    problems[option] = { ...problems[option], ...rows };
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
 *  knowledge with a problem off. */
export function withoutProblems(
  config: SbxProjectConfig,
  knowledge: SbxKnowledgeConfig,
  problems: SbxProblems
): { config: SbxProjectConfig; knowledge: SbxKnowledgeConfig } {
  const fine = (option: SbxOption, row: string): boolean => problems[option]?.[row] === undefined;
  const next = { ...knowledge };
  for (const kind of SBX_KNOWLEDGE_KINDS.filter((candidate) => !fine("knowledge", candidate))) {
    next[kind] = false;
  }
  return {
    config: {
      ...config,
      ports: config.ports.filter((port) => fine("ports", sbxPortKey(port))),
      paths: config.paths.filter((entry) => fine("paths", entry.path)),
      hosts: config.hosts.filter((host) => fine("hosts", host)),
      secrets: config.secrets.filter((secret) => fine("secrets", secret.env)),
      variables: config.variables.filter((variable) => fine("variables", variable.env))
    },
    knowledge: next
  };
}
