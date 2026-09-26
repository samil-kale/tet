/**
 * sbx's filesystem policy, evaluated in tet: sbx has `policy check network` but no filesystem
 * counterpart. This only predicts sbx's own enforcement, for the dialog's marks and what a Save or
 * a spawn leaves out (sbx.ts's readSbxProblems); a mount sbx refuses all the same is left out and
 * told too (prepareSbxRun). Pure, so testable.
 *
 * Grammar: `*` within one segment, `**` any depth, `~` home on every platform, `*:` any Windows
 * drive, a pattern matches only its own path format, no env expansion. Where sbx leaves it open,
 * decided leniently (a wrong blocker costs more than a refused mount): case is ignored on win32,
 * and `dir/**` covers `dir`.
 */

import type { SbxAccess, SbxStatus } from "../shared/types";
import { isRecord } from "./json-file";

type FilesystemAction = "read" | "write";

/**
 * The organization in `sbx policy ls`'s first line on a governed account ("Governance: Managed by
 * <org> | …"). An ungoverned account has no such line. sbx words a failed lookup "managed by
 * unknown organization (lookup failed)", which is shown as it stands.
 */
export function parseGovernance(policyList: string): string | undefined {
  return /^Governance:\s*Managed by\s+([^|\r\n]+?)\s*(?:\||$)/im.exec(policyList)?.[1];
}

/** The first of sbx's setup steps still missing, as the user is told it (a tab's notice, tet-ctl's
 *  answer: control-server.ts may not import sbx.ts), each caller adding its own suffix; undefined
 *  once sbx is installed, signed in and has a network policy. */
export function sbxNotReady(status: SbxStatus): string | undefined {
  if (!status.installed) {
    return "SBX is not installed (or no longer on PATH)";
  }
  if (status.failure) {
    return `SBX failed: ${status.failure}`;
  }
  if (!status.loggedIn) {
    return "SBX is not signed in to Docker";
  }
  if (!status.policyInitialized) {
    return "SBX's network policy is not set up";
  }
  return undefined;
}

export interface FilesystemRule {
  actions: FilesystemAction[];
  decision: "allow" | "deny";
  resources: string[];
}

/**
 * The active rules of `sbx policy ls --type filesystem --json` (`rules[]`: `resource_type`
 * "filesystem:read" | "filesystem:write" | "filesystem", `decision`, `resources`, `status`
 * "inactive" for a local rule an organization overrides). Unreadable is no rules — all denied.
 */
export function parseFilesystemRules(json: string): FilesystemRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
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
  platform: NodeJS.Platform;
  home: string;
}

/** `/` separators, no trailing one — the form patterns and paths are compared in. */
function normalize(value: string, flavor: PathFlavor): string {
  const slashed = flavor.platform === "win32" ? value.replace(/\\/g, "/") : value;
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

function patternRegExp(pattern: string, flavor: PathFlavor): RegExp {
  const trimmed = pattern.trim();
  const expanded = /^~(?=$|[/\\])/.test(trimmed) ? flavor.home + trimmed.slice(1) : trimmed;
  const source = normalize(expanded, flavor);
  let regex = "";
  for (let index = 0; index < source.length; index++) {
    const rest = source.slice(index);
    if (index === 0 && flavor.platform === "win32" && rest.startsWith("*:")) {
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
    } else if (rest[0] === "*") {
      regex += "[^/]*";
    } else {
      regex += rest[0].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`, flavor.platform === "win32" ? "i" : "");
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
