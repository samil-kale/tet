import type { AgentId } from "./agents";
import type { GitActionResult } from "./git";

/** Forwards `host` to `container`. Strings as typed; validated only at `sbx run`. */
export interface SbxPort {
  host: string;
  container: string;
}

/** `sbx mount`'s modes (`HOST:TARGET:ro|rw`), labelled Read / Read+Write. */
export const SBX_ACCESS = ["ro", "rw"] as const;

export type SbxAccess = (typeof SBX_ACCESS)[number];

/** An "Allowed paths" row: a host folder or a single file. */
export interface SbxPath {
  path: string;
  access: SbxAccess;
}

/** Which non-identity host knowledge to mount into the sandbox, with which access; `false` is off.
 *  Agent-agnostic — the paths per agent are `AgentSandbox.knowledge`. Kept on this
 *  machine per project, never in tet.json (sbx-local.ts): it names this machine's folders. */
export interface SbxKnowledgeSettings {
  skills: SbxAccess | false;
  /** The personal instructions file — `CLAUDE.md` for Claude, `AGENTS.md` for Codex and pi. */
  instructions: SbxAccess | false;
  /** A folder every agent's skills come from instead of its own, mounted at each one's own skills
   *  folder; absent for each agent's own. */
  skillsFolder?: string;
}

/** The kinds of knowledge, each switched on with an access. */
export type SbxKnowledgeKind = Exclude<keyof SbxKnowledgeSettings, "skillsFolder">;

/** One piece of host knowledge, and where the sandboxed CLI reads it. */
export interface SbxKnowledgeEntry {
  host: string;
  /** Absolute container path, under the sandbox's home. */
  target: string;
}

/** An agent installed on this machine, and what the Knowledge tab's rows mount for it
 *  (sbx-mounts.ts's readKnowledgeSources). */
export interface SbxKnowledgeSource {
  agentId: AgentId;
  displayName: string;
  /** Per kind, what exists here of the agent's own. */
  own: Record<SbxKnowledgeKind, SbxKnowledgeEntry[]>;
  /** Where a chosen `skillsFolder` goes in its sandbox. */
  skillsTargets: string[];
}

/**
 * A "Secrets" row: an sbx custom secret. The sandbox sees `env` set to a placeholder, and sbx's
 * proxy swaps it for the value in requests to `hosts` (sbx.ts's applySecrets). Never the value,
 * which stays on this machine (sbx-local.ts).
 */
export interface SbxSecret {
  env: string;
  /** Exact host, IP or wildcard (`*.example.com`) — sbx refuses a scheme or port. */
  hosts: string[];
}

/**
 * A "Variables" row: `env` set in the sandbox with its real value — which, unlike a secret's, the
 * sandbox sees (sbx.ts's sandboxEnv). Never the value, which stays on this machine (sbx-local.ts).
 */
export interface SbxVariable {
  env: string;
}

/** Per project, for every sandboxed tab whatever its agent. No authentication: each agent signs in
 *  inside the sandbox, pi excepted (a credential from sbx's own store, see pi's `sandbox.kit`). */
export interface SbxProjectSettings {
  enabled: boolean;
  ports: SbxPort[];
  paths: SbxPath[];
  /** "Allowed hosts" in sbx's grammar — exact host, wildcard (`*.example.com`), optional port.
   *  Unvalidated: sbx accepts anything, and a scheme then matches nothing. */
  hosts: string[];
  secrets: SbxSecret[];
  variables: SbxVariable[];
  /** A script, by its lines (sbx-rules.ts's setupLines), run by `sh -e` as root in each sandbox at a
   *  tab's start: once per sandbox, and again once its text changes (sbx.ts's runSetup). What an
   *  earlier version did is not undone. */
  setup: string[];
}

/** The two lists of the SBX Settings whose values stay on this machine (sbx-local.ts). */
export type SbxValueKind = "secrets" | "variables";

/** What the SBX Settings keep on this machine, never in tet.json (sbx-local.ts): which Secrets and
 *  Variables rows hold a value here — never a value — and the knowledge. */
export interface SbxStoredLocal extends Record<SbxValueKind, string[]> {
  knowledge: SbxKnowledgeSettings;
}

/**
 * Save's part of one list for this machine, both by the row's env name: the values typed since
 * opening, and the name each row was opened under — its stored value follows a renamed row, and a
 * row added under a stored name does not inherit that value.
 */
export interface SbxLocalEdits {
  values: Record<string, string>;
  from: Record<string, string>;
}

export interface SbxLocalSave extends Record<SbxValueKind, SbxLocalEdits> {
  knowledge: SbxKnowledgeSettings;
}

/** Every kind off, each agent's own skills: no knowledge stored for a project. */
export const EMPTY_SBX_KNOWLEDGE: SbxKnowledgeSettings = { skills: false, instructions: false };

/** A rule sbx's policy must allow before TET can sandbox a project (sbx-status.ts's
 *  readSbxBlockers). */
export interface SbxBlocker {
  /** What it is for, a word or two. */
  what: string;
  /** The rule to ask for, in sbx's own grammar. */
  allow: string;
}

/** Checked before the SBX Settings show its fields (sbx-status.ts's readSbxStatus). Each field means
 *  something only when the one above is true. */
export interface SbxStatus {
  installed: boolean;
  signedIn: boolean;
  /** sbx's own error when it failed for a reason other than being signed out (a hung daemon), or
   *  that it is older than TET drives (sbx-cli.ts's sbxVersionSupported), with `signedIn` false;
   *  signing in would not help. Or, signed in, that its policy could not be read (readSbxStatus). */
  failure?: string;
  policyInitialized: boolean;
  /** The organization managing the account's policies, when one does; local allow rules then do
   *  not apply. */
  organization?: string;
  /** Shown instead of the dialog's fields while non-empty. */
  blockers: SbxBlocker[];
}

/** A Docker access token kept for the SBX Settings' General tab (sbx-accounts.ts), for every
 *  project; the token itself never reaches the renderer. */
export interface SbxAccount {
  id: string;
  /** The Docker username `sbx login --username` takes with the token. */
  user: string;
}

/** One access token row at Save: `id` the account it was opened as, `token` what was typed since
 *  ("" keeps the stored one). */
export interface SbxAccountEdit {
  id?: string;
  user: string;
  token: string;
}

/** A sign-in's answer: whether sbx took the token, the account kept for it, and else why not —
 *  what sbx said on refusing, or, signed in all the same, why the token could not be kept. */
export interface SbxSignInResult {
  signedIn: boolean;
  account?: SbxAccount;
  error?: string;
}

/** What the SBX Settings apply, by the dialog tab each is on: what a problem is told under. */
export type SbxOption = "hosts" | "paths" | "knowledge" | "ports" | "secrets" | "variables" | "setup";

/**
 * What of the SBX Settings cannot be applied here, per option: each row's key (the host, the path
 * as configured, the knowledge kind, `host:container`, the env name, the setup script's last error
 * line) with what is wrong with it (sbx.ts's readSbxProblems). Such a row is neither saved nor
 * applied — the setup script, known to fail only once run, is saved and tried again at the next
 * start.
 */
export type SbxProblems = Partial<Record<SbxOption, Record<string, string>>>;

/** A Save's answer: what it left out, so the caller can say it. */
export interface SbxSaveResult extends GitActionResult {
  problems?: SbxProblems;
}

/** No `sbx` section in tet.json; also the dialog's initial state. */
export const EMPTY_SBX_SETTINGS: SbxProjectSettings = {
  enabled: false,
  ports: [],
  paths: [],
  hosts: [],
  secrets: [],
  variables: [],
  setup: [],
};
