import { SBX_PROBLEM } from "../../shared/sbx-rules";
import type { SbxMcpServer, SbxRegisteredMcp } from "../../shared/types/sbx";
import { runSbx, sbxFailure, sbxJson, sbxRefusal, type OnData } from "./sbx-cli";

/** One entry of `sbx mcp ls --json`. */
interface ListedMcp {
  name?: string;
  transport?: string;
  status?: string;
}

/** One `sbx mcp inspect NAME --json`: `url` only on a remote server. */
interface InspectedMcp {
  url?: string;
}

/** The names sbx has registered, from one `mcp ls --json` (`[]` when none). Undefined when sbx does
 *  not answer: read as none, every server would be registered a second time. */
async function listMcp(): Promise<ListedMcp[] | undefined> {
  const listed = await sbxJson<ListedMcp[]>(["mcp", "ls", "--json"]);
  return Array.isArray(listed) ? listed : undefined;
}

export async function readMcpNames(): Promise<Set<string> | undefined> {
  const listed = await listMcp();
  return listed && new Set(listed.flatMap((entry) => (entry.name ? [entry.name] : [])));
}

/**
 * The servers sbx has registered, each with the URL it was registered under (empty for a local
 * command), for the MCP tab's picker and the check of a typed row against its registration. Only
 * `only`'s when given, as each is an `inspect`. Undefined when sbx does not answer.
 */
export async function readRegisteredMcp(only?: readonly string[]): Promise<SbxRegisteredMcp[] | undefined> {
  const listed = await listMcp();
  if (!listed) {
    return undefined;
  }
  const wanted = listed.filter((entry) => entry.name && (only === undefined || only.includes(entry.name)));
  return Promise.all(
    wanted.map(async (entry) => {
      const inspected = await sbxJson<InspectedMcp>(["mcp", "inspect", entry.name ?? "", "--json"]);
      return { name: entry.name ?? "", url: inspected?.url ?? "", transport: entry.transport ?? "", status: entry.status ?? "" };
    }),
  );
}

/**
 * Registers each row sbx does not have yet, from its URL, and returns what sbx refused (or could not
 * be asked) by name. An existing registration is never replaced: it may be another's. `--skip-auth`:
 * the OAuth flow would open a browser in the middle of a Save or a tab's start.
 */
async function registerMcp(
  servers: readonly SbxMcpServer[],
  registered: ReadonlySet<string>,
  onData?: OnData,
): Promise<Record<string, string>> {
  const refused: Record<string, string> = {};
  for (const { name, url } of servers.filter((server) => !registered.has(server.name))) {
    if (!url) {
      refused[name] = SBX_PROBLEM.mcpUnregistered;
      continue;
    }
    const result = await runSbx(["mcp", "add", name, "--url", url, "--skip-auth"], { onData });
    if (!result.ok) {
      refused[name] = sbxRefusal(result);
    }
  }
  return refused;
}

/**
 * Loads each server into a running sandbox: its MCP gateway is up only while it runs, a stopped one
 * answers 409 "no MCP gateway is running", so the callers hold a running one (a tab's start, a Save
 * for the sandboxes `sbx ls` lists as running). sbx keeps a load across a stop, and loading one that
 * is loaded is no error. Returns what sbx refused, by name.
 */
export async function loadMcp(sandbox: string, names: readonly string[], onData?: OnData): Promise<Record<string, string>> {
  const refused: Record<string, string> = {};
  for (const name of names) {
    const result = await runSbx(["mcp", "load", name, "--sandbox", sandbox], { onData });
    if (!result.ok) {
      refused[name] = sbxRefusal(result);
    }
  }
  return refused;
}

/**
 * Unloads each server from a running sandbox (as loadMcp), ending its tools *now*, as a revoked
 * mount does. Unloading one that is not loaded answers 404 with exit 1 and no code of its own, so
 * that answer is told by its words — the one place that does: it is what the row was removed for.
 * The registration stays.
 */
export async function unloadMcp(sandbox: string, names: readonly string[], onData?: OnData): Promise<Record<string, string>> {
  const refused: Record<string, string> = {};
  for (const name of names) {
    const result = await runSbx(["mcp", "unload", name, "--sandbox", sandbox], { onData });
    if (!result.ok && !sbxRefusal(result).includes("is not loaded")) {
      refused[name] = sbxRefusal(result);
    }
  }
  return refused;
}

/** `sbx mcp auth`, which opens the browser and waits on the server's OAuth flow; what sbx said on
 *  refusing, else undefined. Stopped by the dialog's Cancel (cancelSbxSetup). */
export async function signInMcp(name: string): Promise<string | undefined> {
  const result = await runSbx(["mcp", "auth", name], { cancellable: true });
  return result.ok ? undefined : sbxFailure(result, "sbx mcp auth");
}

/** What the project's MCP rows ask of a sandbox, once its servers are registered (planMcp). */
export interface McpPlan {
  /** What sbx would not register, or could not be asked, by name. */
  refused: Record<string, string>;
  load: string[];
  /** Every other server sbx has registered: sbx lists none of a sandbox's loads, so whatever is not
   *  a row is unloaded, one loaded by hand too, as a host allowed by hand goes (readSandboxHosts). */
  unload: string[];
}

/**
 * Registers the rows sbx does not have (registerMcp) and says what a sandbox is then to load and
 * unload, for a tab's start and a Save alike. A row sbx would not register is not loaded. With
 * `registered` undefined, sbx could not list its servers: every row is refused and nothing unloaded.
 */
export async function planMcp(
  servers: readonly SbxMcpServer[],
  registered: ReadonlySet<string> | undefined,
  onData?: OnData,
): Promise<McpPlan> {
  if (!registered) {
    return { refused: Object.fromEntries(servers.map((server) => [server.name, SBX_PROBLEM.mcpUnlisted])), load: [], unload: [] };
  }
  const refused = await registerMcp(servers, registered, onData);
  return {
    refused,
    load: servers.filter((server) => refused[server.name] === undefined).map((server) => server.name),
    unload: [...registered].filter((name) => !servers.some((server) => server.name === name)),
  };
}
