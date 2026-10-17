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

/** Which non-identity host skills to mount into the sandbox, with which access; `false` is off.
 *  Agent-agnostic — the paths per agent are `AgentSandbox.skills`. Kept on this
 *  machine per project, never in tet.json (sbx-local.ts): it names this machine's folders. */
export interface SbxSkillsSettings {
  skills: SbxAccess | false;
  /** The personal instructions file — `CLAUDE.md` for Claude, `AGENTS.md` for Codex and pi. */
  instructions: SbxAccess | false;
  /** A folder every agent's skills come from instead of its own, mounted at each one's own skills
   *  folder; absent for each agent's own. */
  skillsFolder?: string;
}

/** The kinds of skills, each switched on with an access. */
export type SbxSkillsKind = Exclude<keyof SbxSkillsSettings, "skillsFolder">;

/** One piece of host skills, and where the sandboxed CLI reads it. */
export interface SbxSkillsEntry {
  host: string;
  /** Absolute container path, under the sandbox's home. */
  target: string;
}

/** An agent installed on this machine, and what the Skills tab's rows mount for it
 *  (sbx-mounts.ts's readSkillsSources). */
export interface SbxSkillsSource {
  agentId: AgentId;
  displayName: string;
  /** Per kind, what exists here of the agent's own. */
  own: Record<SbxSkillsKind, SbxSkillsEntry[]>;
  /** Where a chosen `skillsFolder` goes in its sandbox. */
  skillsTargets: string[];
}

/**
 * An "MCP" row: an MCP server by its sbx name, registered with sbx when it is not yet (sbx-mcp.ts's
 * planMcp) and loaded into every sandbox of the project. `url` is what a missing registration
 * is made from; empty for a registered server without one (a local command), which is only loaded.
 */
export interface SbxMcpServer {
  name: string;
  url: string;
}

/** sbx's status word for a registered server that wants a sign-in (`sbx mcp ls --json`). */
export const SBX_MCP_NEEDS_AUTH = "needs-auth";

/** A server sbx has registered, for the MCP tab's picker (sbx-mcp.ts's readRegisteredMcp). */
export interface SbxRegisteredMcp extends SbxMcpServer {
  /** sbx's own words for how it is reached, e.g. `remote http`. */
  transport: string;
  /** sbx's own status word, `needs-auth` while the server wants a sign-in. */
  status: string;
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
  /** The "Environment" rows: env names set in the sandbox with their real values, which the sandbox
   *  sees (sbx.ts's sandboxEnv). Never a value, which stays on this machine (sbx-local.ts). */
  environment: string[];
  /** Loaded into every running sandbox of the project at Save and into any other at its next tab's
   *  start, where a row removed is unloaded too (sbx.ts's alignSandbox). The registration stays. */
  mcp: SbxMcpServer[];
  /** A script, by its lines (sbx-rules.ts's setupLines), run by `sh -e` as root in each sandbox at a
   *  tab's start: once per sandbox, and again once its text changes (sbx.ts's runSetup). What an
   *  earlier version did is not undone. */
  setup: string[];
}

/** What the SBX Settings keep on this machine, never in tet.json (sbx-local.ts): which Environment
 *  rows hold a value here — never a value — and the skills. */
export interface SbxStoredLocal {
  environment: string[];
  skills: SbxSkillsSettings;
}

/**
 * Save's part of the Environment for this machine, both by the row's env name: the values typed since
 * opening, and the name each row was opened under — its stored value follows a renamed row, and a
 * row added under a stored name does not inherit that value.
 */
export interface SbxLocalEdits {
  values: Record<string, string>;
  from: Record<string, string>;
}

export interface SbxLocalSave {
  environment: SbxLocalEdits;
  skills: SbxSkillsSettings;
}

/** Every kind off, each agent's own skills: no skills stored for a project. */
export const EMPTY_SBX_SKILLS: SbxSkillsSettings = { skills: false, instructions: false };

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
export type SbxOption = "hosts" | "paths" | "skills" | "ports" | "environment" | "mcp" | "setup";

/**
 * What of the SBX Settings cannot be applied here, per option: each row's key (the host, the path
 * as configured, the skills kind, `host:container`, the env name, the setup script's last error
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
  environment: [],
  mcp: [],
  setup: [],
};
