/**
 * sbx's filesystem policy, evaluated in tet — sbx has `policy check network` but no filesystem
 * counterpart (0.42.1, and none in the release notes up to 0.43.0-rc3), while it enforces mounts
 * itself at `create`, `mount` and every start. This only has to predict that enforcement well
 * enough to tell a user up front what to ask their organization for; a mount sbx refuses anyway
 * still stops the tab (prepareSbxRun). Pure, so the rules are testable against measured output.
 *
 * Pattern grammar per Docker's docs (governance concepts, "Filesystem rules"): `*` stays within
 * one path segment, `**` crosses any depth, `~` is the home directory on every platform, `*:` is
 * any drive letter on Windows, a pattern matches only the path format it is written in, and no
 * environment variable is expanded. Undocumented, and decided leniently here since a wrong
 * blocker costs more than a mount refused at start: case (ignored on win32, as its paths are),
 * and whether `dir/**` covers `dir` itself (it does).
 */

export type FilesystemAction = "read" | "write";

export interface FilesystemRule {
  actions: FilesystemAction[];
  decision: "allow" | "deny";
  resources: string[];
}

/**
 * The active filesystem rules of `sbx policy ls --type filesystem --json` (`rules[]` with
 * `resource_type` "filesystem:read" | "filesystem:write" | "filesystem", `decision`, `resources`,
 * and `status` "inactive" for a local rule an organization's policy overrides). Anything
 * unreadable is no rules — which evaluates as everything denied.
 */
export function parseFilesystemRules(json: string): FilesystemRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const rules = (parsed as { rules?: unknown }).rules;
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

/** Separators as `/`, no trailing one — the one form both a pattern and a path are compared in. */
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
 * Whether sbx would let `hostPath` be mounted with `access`. A deny for an action the mount needs
 * wins over every allow; otherwise an allow has to match, default deny. Read-write needs a write
 * allow; read-only a read *or* write allow. Docker's docs say a writable mount needs both a read
 * and a write rule and a read-only one a read rule — but an organization granting write alone
 * (`C:\**`, `/**`) was measured to let both kinds mount (sbx 0.42.1), so what the binary does
 * decides here.
 */
export function isMountAllowed(rules: FilesystemRule[], hostPath: string, access: "ro" | "rw", flavor: PathFlavor): boolean {
  const target = normalize(hostPath, flavor);
  const matching = rules.filter((rule) => rule.resources.some((resource) => patternRegExp(resource, flavor).test(target)));
  const deniedBy: FilesystemAction[] = access === "rw" ? ["read", "write"] : ["read"];
  if (matching.some((rule) => rule.decision === "deny" && rule.actions.some((action) => deniedBy.includes(action)))) {
    return false;
  }
  const allowedBy: FilesystemAction[] = access === "rw" ? ["write"] : ["read", "write"];
  return matching.some((rule) => rule.decision === "allow" && rule.actions.some((action) => allowedBy.includes(action)));
}
