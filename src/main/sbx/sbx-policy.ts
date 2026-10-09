/**
 * sbx's filesystem policy, evaluated in TET: sbx has `policy check network` but no filesystem
 * counterpart. This only predicts sbx's own enforcement, for the dialog's marks and what a Save or
 * a spawn leaves out (sbx.ts's readSbxProblems); a mount sbx refuses all the same is left out and
 * told too (prepareSbxRun). Pure, so testable.
 *
 * Grammar: `*` within one segment, `**` any depth, `~` home on every platform, `*:` any Windows
 * drive, a pattern matches only its own path format, no env expansion. Where sbx leaves it open,
 * decided leniently (a wrong blocker costs more than a refused mount): case is ignored on win32,
 * and `dir/**` covers `dir`.
 */

import type { Platform } from "../../shared/platform";
import type { SbxAccess, SbxBlocker, SbxStatus } from "../../shared/types/sbx";
import { isRecord } from "../util/json-file";

type FilesystemAction = "read" | "write";

/**
 * The organization of `sbx policy ls --json` on a governed account (`organization`;
 * `organization_unavailable` when sbx could not look it up). An ungoverned account has neither.
 */
export function parseGovernance(json: string): string | undefined {
  const parsed = parseSbxJson(json);
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (typeof parsed.organization === "string" && parsed.organization) {
    return parsed.organization;
  }
  return parsed.organization_unavailable === true ? "unknown organization (lookup failed)" : undefined;
}

/** The first of sbx's setup steps still missing, as the user is told it (a tab's notice, tet-ctl's
 *  answer: ctl-sbx-verbs.ts may not import sbx.ts), each caller adding its own suffix; undefined
 *  once sbx is installed, signed in and has a network policy. */
export function sbxNotReady(status: SbxStatus): string | undefined {
  if (!status.installed) {
    return "SBX is not installed, too old or no longer on PATH";
  }
  if (status.failure) {
    return `SBX failed: ${status.failure}`;
  }
  if (!status.signedIn) {
    return "SBX is not signed in to Docker";
  }
  if (!status.policyInitialized) {
    return "SBX's network policy is not set up";
  }
  return undefined;
}

/** What sbx's policy does not allow a sandboxed tab (readSbxBlockers), said once for the spawn and
 *  the control verbs alike; undefined where it allows all. */
export function sbxBlocked(blockers: SbxBlocker[], organization: string | undefined): string | undefined {
  if (blockers.length === 0) {
    return undefined;
  }
  const policy = organization ? `${organization}'s SBX policy` : "SBX's policy";
  return `${policy} does not allow ${blockers.map((blocker) => `${blocker.allow} (${blocker.what})`).join("; ")}`;
}

export interface FilesystemRule {
  actions: FilesystemAction[];
  decision: "allow" | "deny";
  resources: string[];
}

/**
 * A `--json` stdout parsed, undefined when it holds none: sbx appends notices (an update banner) to
 * stdout after the JSON, so what is read is the value from the first `{` or `[` to the last
 * closing one.
 */
export function parseSbxJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.search(/[{[]/);
    const end = Math.max(stdout.lastIndexOf("}"), stdout.lastIndexOf("]"));
    try {
      return start === -1 || end < start ? undefined : JSON.parse(stdout.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/**
 * The active rules of `sbx policy ls --type filesystem --json` (`rules[]`: `resource_type`
 * "filesystem:read" | "filesystem:write" | "filesystem", `decision`, `resources`, `status`
 * "inactive" for a local rule an organization overrides). Unreadable is no rules — all denied.
 * Deliberately not "sbx cannot say" (a failed run is that, readPolicy): sbx's format is
 * trusted, and held by the recorded answer in test/main/sbx.test.ts and the live one in
 * test/e2e/agents.test.ts.
 */
export function parseFilesystemRules(json: string): FilesystemRule[] {
  const parsed = parseSbxJson(json);
  const rules = isRecord(parsed) ? parsed.rules : undefined;
  if (!Array.isArray(rules)) {
    return [];
  }
  return rules.flatMap((raw): FilesystemRule[] => {
    const rule = raw as { resource_type?: unknown; decision?: unknown; resources?: unknown; status?: unknown };
    if (rule.status === "inactive" || (rule.decision !== "allow" && rule.decision !== "deny") || !Array.isArray(rule.resources)) {
      return [];
    }
    const actions: FilesystemAction[] | undefined =
      rule.resource_type === "filesystem:read"
        ? ["read"]
        : rule.resource_type === "filesystem:write"
          ? ["write"]
          : rule.resource_type === "filesystem"
            ? ["read", "write"]
            : undefined;
    if (!actions) {
      return [];
    }
    return [{ actions, decision: rule.decision, resources: rule.resources.filter((entry): entry is string => typeof entry === "string") }];
  });
}

export interface PathFlavor {
  platform: Platform;
  home: string;
}

/** `/` separators, no trailing one — the form patterns and paths are compared in. */
function normalize(value: string, flavor: PathFlavor): string {
  const slashed = flavor.platform.pathSeparator === "\\" ? value.replace(/\\/g, "/") : value;
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

function patternRegExp(pattern: string, flavor: PathFlavor): RegExp {
  const trimmed = pattern.trim();
  const expanded = /^~(?=$|[/\\])/.test(trimmed) ? flavor.home + trimmed.slice(1) : trimmed;
  const source = normalize(expanded, flavor);
  let regex = "";
  for (let index = 0; index < source.length; index++) {
    const rest = source.slice(index);
    if (index === 0 && flavor.platform.driveLetters && rest.startsWith("*:")) {
      regex += "[A-Za-z]:";
      index += 1;
    } else if (rest === "**") {
      regex += ".*";
      index += 1;
    } else if (rest === "/**") {
      regex += "(?:/.*)?";
      index += 2;
    } else if (rest.startsWith("**/")) {
      regex += "(?:.*/)?";
      index += 2;
    } else if (rest.startsWith("**")) {
      regex += ".*";
      index += 1;
    } else if (rest.startsWith("*")) {
      regex += "[^/]*";
    } else {
      regex += rest[0].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`, flavor.platform.sbxRulesIgnoreCase ? "i" : "");
}

/**
 * Whether sbx would mount `hostPath` with `access`. A matching deny wins; else an allow must match
 * (default deny): read-write needs a write allow, read-only a read *or* write allow — a write-only
 * grant allows both.
 */
export function isMountAllowed(rules: FilesystemRule[], hostPath: string, access: SbxAccess, flavor: PathFlavor): boolean {
  const target = normalize(hostPath, flavor);
  const matching = rules.filter((rule) => rule.resources.some((resource) => patternRegExp(resource, flavor).test(target)));
  const deniedBy: FilesystemAction[] = access === "rw" ? ["read", "write"] : ["read"];
  if (matching.some((rule) => rule.decision === "deny" && rule.actions.some((action) => deniedBy.includes(action)))) {
    return false;
  }
  const allowedBy: FilesystemAction[] = access === "rw" ? ["write"] : ["read", "write"];
  return matching.some((rule) => rule.decision === "allow" && rule.actions.some((action) => allowedBy.includes(action)));
}
