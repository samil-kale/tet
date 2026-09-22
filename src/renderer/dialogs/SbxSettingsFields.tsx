import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type {
  SbxAccess,
  SbxAgentKnowledge,
  SbxKnowledgeConfig,
  SbxLocalEdits,
  SbxLocalSave,
  SbxPath,
  SbxPort,
  SbxProjectConfig,
  SbxStoredLocal
} from "../../shared/types";
import { isEnvName, isReservedName } from "../../shared/env-rules";
import { isWindows } from "../platform";
import { ActionLink } from "../ui/ActionLink";
import { EditRow, patched, RowSection, withId, without, type Row } from "../ui/RowSection";
import { Dropdown } from "../ui/Dropdown";
import { Checkbox } from "../ui/Field";

const ACCESS_OPTIONS: { value: SbxAccess; label: string }[] = [
  { value: "ro", label: "Read" },
  { value: "rw", label: "Read+Write" }
];

/** One row per `SbxKnowledgeConfig` kind, in display order. Labels only; the per-agent host paths
 *  are `AgentDefinition.sandboxKnowledge`. */
const KNOWLEDGE_LABELS: { kind: keyof SbxKnowledgeConfig; label: string }[] = [
  { kind: "skills", label: "Skills" },
  { kind: "plugins", label: "Plugins" },
  { kind: "instructions", label: "CLAUDE.md / AGENTS.md" }
];

/** Why no sandbox brings a knowledge kind: without an agent only the shared skills folder counts
 *  (sbx.ts's sandboxKnowledgeFor). */
function knowledgeMissing(kind: keyof SbxKnowledgeConfig, agentInstalled: boolean): string {
  if (agentInstalled) {
    return "None found on this machine";
  }
  return kind === "skills" ? "No ~/.agents/skills folder on this machine" : "Only from an installed agent";
}

/** How long typing in a secret's hosts pauses before they are checked against sbx's policy. */
const HOST_CHECK_DELAY_MS = 500;

export interface FieldsState {
  /** tet.json's `knowledge`; what each kind mounts is `AgentDefinition.sandboxKnowledge`. */
  knowledge: SbxKnowledgeConfig;
  ports: Row<SbxPort>[];
  paths: Row<SbxPath>[];
  hosts: Row<{ host: string }>[];
  /** `hosts` as typed, comma-separated; `value` only what was typed since opening — a stored one
   *  never reaches the renderer; `from` the name a row was opened under (SbxLocalEdits). */
  secrets: Row<{ env: string; hosts: string; value: string; from?: string }>[];
  /** `value` and `from` as for `secrets`. */
  variables: Row<{ env: string; value: string; from?: string }>[];
}

/** `sbx:get-config`'s answer as rows. Only the user's paths: tet's directories and each agent's
 *  session directory are always mounted (sbx.ts's fixedMountSpecs, sessionMountSpecs), not shown. */
export function fromConfig(config: SbxProjectConfig): FieldsState {
  return {
    knowledge: config.knowledge,
    ports: config.ports.map(withId),
    paths: config.paths.map(withId),
    hosts: config.hosts.map((host) => withId({ host })),
    secrets: config.secrets.map((secret) =>
      withId({ env: secret.env, hosts: secret.hosts.join(", "), value: "", from: secret.env })
    ),
    variables: config.variables.map((variable) => withId({ env: variable.env, value: "", from: variable.env }))
  };
}

/** What `sbx ports --publish` and `sbx run -p` take: a whole number from 1 to 65535. */
function isPort(value: string): boolean {
  const trimmed = value.trim();
  return /^\d{1,5}$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= 65535;
}

/** A port row Save refuses: anything but two ports or two empty sides (dropped). */
function isBadPortRow({ host, container }: SbxPort): boolean {
  return !(host.trim() === "" && container.trim() === "") && !(isPort(host) && isPort(container));
}

type SecretRow = FieldsState["secrets"][number];

function secretHosts(row: SecretRow): string[] {
  return row.hosts
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function isEmptySecretRow(row: SecretRow): boolean {
  return row.env.trim() === "" && row.hosts.trim() === "" && row.value === "";
}

/** A secret row Save refuses (an empty one is dropped): it needs a variable name of its own and
 *  hosts, none of them bad (isBadHost). */
function isBadSecretRow(row: SecretRow, rows: SecretRow[]): boolean {
  if (isEmptySecretRow(row)) {
    return false;
  }
  const env = row.env.trim();
  const hosts = secretHosts(row);
  return (
    !isEnvName(env) ||
    rows.some((other) => other.id !== row.id && other.env.trim() === env) ||
    hosts.length === 0 ||
    hosts.some(isBadHost)
  );
}

type VariableRow = FieldsState["variables"][number];

function isEmptyVariableRow(row: VariableRow): boolean {
  return row.env.trim() === "" && row.value === "";
}

/** A name as the machine compares it: win32 takes `a` and `A` for one variable. */
function sameName(name: string): string {
  return isWindows() ? name.toUpperCase() : name;
}

/** A variable row Save refuses (an empty one is dropped): it needs a variable name no other row,
 *  secret or variable, holds — the sandbox sees one value per name, and `sbx run -e NAME` reads a
 *  variable's from this machine's environment, which on win32 ignores case — and not one of tet's
 *  own (isReservedName): its value is set on `sbx run` itself (sbx.ts's sandboxEnv). */
function isBadVariableRow(row: VariableRow, state: FieldsState): boolean {
  if (isEmptyVariableRow(row)) {
    return false;
  }
  const env = row.env.trim();
  return (
    !isEnvName(env) ||
    isReservedName(env) ||
    state.variables.some((other) => other.id !== row.id && sameName(other.env.trim()) === sameName(env)) ||
    state.secrets.some((secret) => secret.env.trim() === env)
  );
}

const BAD_VARIABLE = "Needs a variable name no secret or other variable holds, not PATH or TET_*";

/** A scheme or port, which `sbx secret set-custom` rejects (measured), or a leading "-", which sbx
 *  would read as an option of its own. */
function isBadHost(host: string): boolean {
  return /^-|[/:]/.test(host);
}

/** Why Save waits, or `undefined`: every port row two ports or empty, every secret and variable row
 *  complete or empty. The rows mark which is not. */
export function saveBlocked(state: FieldsState): string | undefined {
  if (state.ports.some(isBadPortRow)) {
    return "A port on the Ports tab is not a whole number from 1 to 65535";
  }
  if (state.secrets.some((row) => isBadSecretRow(row, state.secrets))) {
    return "A secret on the Secrets tab needs a variable name of its own and hosts without scheme or port";
  }
  if (state.variables.some((row) => isBadVariableRow(row, state))) {
    return "A variable on the Variables tab needs a name no secret or other variable holds, not PATH or TET_*";
  }
  return undefined;
}

/** The inverse, for Save: ids dropped, as are empty port, host, secret and variable rows. */
export function toConfig(state: FieldsState): Omit<SbxProjectConfig, "enabled"> {
  return {
    knowledge: state.knowledge,
    ports: state.ports
      .map(({ host, container }) => ({ host: host.trim(), container: container.trim() }))
      .filter((port) => port.host && port.container),
    paths: state.paths.map(({ path, access }) => ({ path, access })),
    hosts: state.hosts.map(({ host }) => host.trim()).filter(Boolean),
    secrets: state.secrets
      .filter((row) => !isEmptySecretRow(row))
      .map((row) => ({ env: row.env.trim(), hosts: secretHosts(row) })),
    variables: state.variables.filter((row) => !isEmptyVariableRow(row)).map((row) => ({ env: row.env.trim() }))
  };
}

/** One list's rows as Save stores them on this machine; a row left without a name holds nothing. */
function toLocalEdits(rows: { env: string; value: string; from?: string }[]): SbxLocalEdits {
  const named = rows.filter((row) => row.env.trim() !== "");
  return {
    values: Object.fromEntries(named.filter((row) => row.value !== "").map((row) => [row.env.trim(), row.value])),
    from: Object.fromEntries(named.flatMap((row) => (row.from === undefined ? [] : [[row.env.trim(), row.from]])))
  };
}

/** The values typed since opening and each row's name when opened, for Save (SbxLocalEdits). */
export function toLocalSave(state: FieldsState): SbxLocalSave {
  return { secrets: toLocalEdits(state.secrets), variables: toLocalEdits(state.variables) };
}

/** Whether the row holds a value on this machine: the one of the name it was opened under. */
function holdsValue(row: { from?: string }, stored: readonly string[]): boolean {
  return row.from !== undefined && stored.includes(row.from);
}

/**
 * Whether the edits since `loaded` reach a running tab only once it restarts: a mount is added at a
 * tab's start (a removed one goes at Save), and `sbx run -e` sets a variable, a new secret's
 * placeholder included, only there (sbx.ts's prepareSbxRun). Ports, hosts and a secret's value or
 * hosts apply at Save.
 */
export function needsRestart(loaded: SbxProjectConfig, state: FieldsState): boolean {
  const config = toConfig(state);
  const names = (variables: SbxProjectConfig["variables"]): string => JSON.stringify(variables.map((variable) => variable.env).sort());
  return (
    KNOWLEDGE_LABELS.some(({ kind }) => config.knowledge[kind] !== false && config.knowledge[kind] !== loaded.knowledge[kind]) ||
    config.paths.some((entry) => !loaded.paths.some((old) => old.path === entry.path && old.access === entry.access)) ||
    config.secrets.some((secret) => !loaded.secrets.some((old) => old.env === secret.env)) ||
    names(config.variables) !== names(loaded.variables) ||
    state.variables.some((row) => row.value !== "")
  );
}

/** sbx's policy on the rows, for their marks (usePolicyAnswers). */
export interface PolicyAnswers {
  /** Row ids of Allowed paths sbx's policy would refuse to mount (sbx.ts's readMountsAllowed). */
  deniedPaths: ReadonlySet<string>;
  /** Per secret host answered so far, whether a sandbox may reach it (sbx.ts's readHostAllowed). */
  hostsAllowed: ReadonlyMap<string, boolean>;
}

/**
 * Asks sbx's policy about the paths and the secrets' hosts as soon as the dialog has its rows
 * (`ready`), whatever tab shows — so a path or host the policy no longer allows is marked from the
 * start, its tab too — then again on a change. The two run side by side and are never waited on:
 * a mark appears with its answer.
 */
export function usePolicyAnswers(state: FieldsState, ready: boolean): PolicyAnswers {
  const [deniedPaths, setDeniedPaths] = useState<ReadonlySet<string>>(() => new Set());
  // Only a changed path or access asks again; an answer overtaken by an edit is dropped.
  const pathsKey = JSON.stringify(state.paths.map(({ id, path, access }) => [id, path, access]));
  useEffect(() => {
    if (!ready || state.paths.length === 0) {
      return;
    }
    const rows = state.paths;
    let current = true;
    void window.tet.sbx.mountsAllowed(rows.map(({ path, access }) => ({ path, access }))).then((allowed) => {
      if (current) {
        setDeniedPaths(new Set(rows.filter((_row, index) => !allowed[index]).map((row) => row.id)));
      }
    });
    return () => {
      current = false;
    };
    // `pathsKey` holds every field the rows are read for; the array itself is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pathsKey]);

  // Kept while the dialog is open: only a host not asked yet is. An answer holds for its host
  // whatever was edited since, so none is dropped.
  const [hostsAllowed, setHostsAllowed] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  /** Asked and not answered yet — not asked a second time meanwhile. */
  const asking = useRef(new Set<string>());
  // A host the row already refuses (isBadHost) is not asked: it is marked for that.
  const unaskedHosts = [...new Set(state.secrets.flatMap(secretHosts))].filter((host) => !isBadHost(host) && !hostsAllowed.has(host));
  const unaskedKey = JSON.stringify(unaskedHosts);
  /** The saved hosts go at once; a typed one waits (HOST_CHECK_DELAY_MS). */
  const opened = useRef(true);
  useEffect(() => {
    if (!ready) {
      return;
    }
    const delay = opened.current ? 0 : HOST_CHECK_DELAY_MS;
    opened.current = false;
    const hosts = unaskedHosts.filter((host) => !asking.current.has(host));
    if (hosts.length === 0) {
      return;
    }
    // Typed, unlike a picked path: asked once typing pauses, not per keystroke (~0.5 s an sbx call).
    // Each on its own, all at once (sbx.ts's readHostAllowed), so the first refusal marks at once.
    const timer = setTimeout(() => {
      for (const host of hosts) {
        asking.current.add(host);
        void window.tet.sbx
          .hostAllowed(host)
          .then((allowed) => setHostsAllowed((known) => new Map(known).set(host, allowed)))
          .finally(() => asking.current.delete(host));
      }
    }, delay);
    return () => clearTimeout(timer);
    // `unaskedKey` is the serialized list the effect reads, which is new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, unaskedKey]);

  return { deniedPaths, hostsAllowed };
}

/** Who refuses, in the marks and in the dialog's blocked message. */
export function policyName(governed: boolean): string {
  return governed ? "Your organization's SBX policy" : "SBX's policy";
}

/** A path row's mark, or `undefined`. */
function pathMark(row: FieldsState["paths"][number], answers: PolicyAnswers, governed: boolean): string | undefined {
  return answers.deniedPaths.has(row.id)
    ? `${policyName(governed)} does not allow mounting this path${row.access === "rw" ? " with write access" : ""}`
    : undefined;
}

/** A secret row's mark, or `undefined`. One mark: a row Save refuses before one the policy would
 *  leave without effect. */
function secretMark(row: SecretRow, rows: SecretRow[], answers: PolicyAnswers, governed: boolean): string | undefined {
  if (isBadSecretRow(row, rows)) {
    return "Needs a variable name of its own and hosts without scheme or port";
  }
  const unreachable = secretHosts(row).filter((host) => answers.hostsAllowed.get(host) === false);
  return unreachable.length > 0 ? `${policyName(governed)} does not allow the sandbox to reach ${unreachable.join(", ")}` : undefined;
}

const BAD_PORT = "Both ports must be whole numbers from 1 to 65535";

/** Each tab's mark: its first marked row's, repeated on the tab so it shows from any pane. */
export function tabMarks(state: FieldsState, answers: PolicyAnswers, governed: boolean): Partial<Record<keyof FieldsState, string>> {
  const first = (marks: (string | undefined)[]): string | undefined => marks.find((mark) => mark !== undefined);
  return {
    ports: state.ports.some(isBadPortRow) ? BAD_PORT : undefined,
    paths: first(state.paths.map((row) => pathMark(row, answers, governed))),
    secrets: first(state.secrets.map((row) => secretMark(row, state.secrets, answers, governed))),
    variables: state.variables.some((row) => isBadVariableRow(row, state)) ? BAD_VARIABLE : undefined
  };
}

interface SbxSettingsFieldsProps {
  /** Owned by SbxSettingsDialog, which builds the save request. */
  state: FieldsState;
  setState: Dispatch<SetStateAction<FieldsState>>;
  section: keyof FieldsState;
  /** An organization manages sbx's policy; only words the paths' and secrets' marks. */
  governed: boolean;
  /** The env names holding a value on this machine (`sbx:stored`); never a value. */
  stored: SbxStoredLocal;
  /** Asked by the dialog from its opening (usePolicyAnswers), for the tabs' marks too. */
  answers: PolicyAnswers;
  /** Any agent CLI on this machine; only words why a knowledge kind has nothing. */
  agentInstalled: boolean;
  /** What each sandbox would bring from this machine; a kind none brings is disabled. */
  knowledge: SbxAgentKnowledge[];
}

/** One tab of the dialog's fields, shown once sbx is ready (see SbxSettingsDialog). State is
 *  shared across tabs. */
export function SbxSettingsFields({
  state,
  setState,
  section,
  governed,
  stored,
  answers,
  agentInstalled,
  knowledge
}: SbxSettingsFieldsProps) {
  const update = <K extends keyof FieldsState>(key: K, change: (value: FieldsState[K]) => FieldsState[K]): void =>
    setState((current) => ({ ...current, [key]: change(current[key]) }));

  /** `false` turns a kind off; an `SbxAccess` turns it on with that access. */
  const setKnowledge = (kind: keyof SbxKnowledgeConfig, value: SbxAccess | false): void =>
    update("knowledge", (knowledge) => ({ ...knowledge, [kind]: value }));
  /** A cancelled pick adds nothing. Folder and file are two buttons: Electron shows both kinds in
   *  one picker only on macOS (see `projects:pick-file`); sbx mounts either the same way. */
  const addPath = async (picked: Promise<string | null>): Promise<void> => {
    const chosen = await picked;
    if (chosen) {
      update("paths", (paths) => [...paths, withId({ path: chosen, access: "rw" })]);
    }
  };

  if (section === "knowledge") {
    return (
      <div className="dialog-field">
        <span className="dialog-field-label">Bring from this machine</span>
        <div className="sbx-knowledge-rows">
          {KNOWLEDGE_LABELS.map(({ kind, label }) => {
            // What this checkbox mounts, per sandbox: each agent reads its own folders. Shown while
            // unchecked too, so what it would bring is seen before.
            const agents = knowledge.filter((agent) => agent.paths[kind].length > 0);
            // A kind with nothing here shows off but keeps tet.json's value, for a machine that has some.
            const value = agents.length > 0 ? state.knowledge[kind] : false;
            return (
              <div key={kind}>
                <div className="sbx-knowledge-row">
                  <Checkbox
                    label={label}
                    checked={value !== false}
                    disabled={agents.length === 0}
                    onChange={(next) => setKnowledge(kind, next ? "ro" : false)}
                  />
                  {value !== false && (
                    <Dropdown value={value} options={ACCESS_OPTIONS} onChange={(next) => setKnowledge(kind, next)} />
                  )}
                </div>
                {/* Why there is nothing stays readable; only unchecked paths are dimmed. */}
                <div className={value === false && agents.length > 0 ? "sbx-knowledge-paths off" : "sbx-knowledge-paths"}>
                  {agents.length > 0 ? (
                    agents.map((agent) => (
                      <div key={agent.agentId} className="sbx-knowledge-path">
                        <span className="sbx-knowledge-agent">{agent.displayName}</span>
                        <span className="sbx-knowledge-value">{agent.paths[kind].join(", ")}</span>
                      </div>
                    ))
                  ) : (
                    <p className="dialog-detail">{knowledgeMissing(kind, agentInstalled)}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (section === "ports") {
    return (
      <RowSection
        label="Port forwarding"
        empty="No ports forwarded yet"
        rows={state.ports}
        renderRow={(port) => {
          const setPort = (change: Partial<typeof port>): void =>
            update("ports", (ports) => patched(ports, port.id, change));
          return (
            <EditRow
              key={port.id}
              mark={isBadPortRow(port) ? BAD_PORT : undefined}
              remove="Remove port"
              onRemove={() => update("ports", (ports) => without(ports, port.id))}
            >
              <input
                className="sbx-port-input"
                type="text"
                inputMode="numeric"
                placeholder="3000"
                value={port.host}
                onChange={(event) => setPort({ host: event.target.value })}
              />
              <span className="sbx-arrow">→</span>
              <input
                className="sbx-port-input"
                type="text"
                inputMode="numeric"
                placeholder="3000"
                value={port.container}
                onChange={(event) => setPort({ container: event.target.value })}
              />
            </EditRow>
          );
        }}
        add={
          <ActionLink onClick={() => update("ports", (ports) => [...ports, withId({ host: "", container: "" })])}>
            + Add port
          </ActionLink>
        }
      />
    );
  }

  if (section === "paths") {
    return (
      <RowSection
        label="Allowed paths"
        empty="No paths shared yet"
        rows={state.paths}
        renderRow={(row) => (
          <EditRow
            key={row.id}
            mark={pathMark(row, answers, governed)}
            remove="Remove path"
            onRemove={() => update("paths", (paths) => without(paths, row.id))}
          >
            {/* Plain text: the path is what the picker returned. */}
            <span className="sbx-path-value" title={row.path}>
              {row.path}
            </span>
            <Dropdown
              value={row.access}
              options={ACCESS_OPTIONS}
              onChange={(access) => update("paths", (paths) => patched(paths, row.id, { access }))}
            />
          </EditRow>
        )}
        add={
          <div className="sbx-add-paths">
            <ActionLink onClick={() => void addPath(window.tet.projects.pickDirectory("Allow a folder in the sandbox"))}>
              + Add folder
            </ActionLink>
            <ActionLink onClick={() => void addPath(window.tet.projects.pickFile("Allow a file in the sandbox"))}>
              + Add file
            </ActionLink>
          </div>
        }
      />
    );
  }

  if (section === "secrets") {
    return (
      <RowSection
        label="Secrets"
        empty="No secrets yet"
        rows={state.secrets}
        renderRow={(row) => {
          const setSecret = (change: Partial<typeof row>): void =>
            update("secrets", (secrets) => patched(secrets, row.id, change));
          const valueStored = holdsValue(row, stored.secrets);
          return (
            <EditRow
              key={row.id}
              mark={secretMark(row, state.secrets, answers, governed)}
              remove="Remove secret"
              onRemove={() => update("secrets", (secrets) => without(secrets, row.id))}
            >
              <input
                className="row-fixed-input"
                type="text"
                placeholder="GITLAB_TOKEN"
                title="The environment variable the sandbox sees, holding a placeholder instead of the value"
                value={row.env}
                onChange={(event) => setSecret({ env: event.target.value })}
              />
              <input
                className="row-fill-input"
                type="text"
                placeholder="gitlab.example.com"
                title="Where sbx puts the value in place of the placeholder, in request headers only: exact host or *.example.com, comma-separated, no scheme or port"
                value={row.hosts}
                onChange={(event) => setSecret({ hosts: event.target.value })}
              />
              <input
                className="row-fixed-input"
                type="password"
                autoComplete="off"
                // A stored value as a set password shows, never the value itself (the title says so).
                placeholder={valueStored ? "••••••••" : "Value"}
                title={
                  valueStored
                    ? "Stored on this machine; typing replaces it. The sandbox never sees it."
                    : "Stored on this machine, never in tet.json. The sandbox never sees it."
                }
                value={row.value}
                onChange={(event) => setSecret({ value: event.target.value })}
              />
            </EditRow>
          );
        }}
        add={
          <ActionLink
            onClick={() => update("secrets", (secrets) => [...secrets, withId({ env: "", hosts: "", value: "" })])}
          >
            + Add secret
          </ActionLink>
        }
      />
    );
  }

  if (section === "variables") {
    return (
      <RowSection
        label="Variables"
        empty="No variables yet"
        rows={state.variables}
        renderRow={(row) => {
          const setVariable = (change: Partial<typeof row>): void =>
            update("variables", (variables) => patched(variables, row.id, change));
          const valueStored = holdsValue(row, stored.variables);
          return (
            <EditRow
              key={row.id}
              mark={isBadVariableRow(row, state) ? BAD_VARIABLE : undefined}
              remove="Remove variable"
              onRemove={() => update("variables", (variables) => without(variables, row.id))}
            >
              <input
                className="row-fill-input"
                type="text"
                placeholder="NPM_TOKEN"
                title="The environment variable the sandbox sees, holding the value itself"
                value={row.env}
                onChange={(event) => setVariable({ env: event.target.value })}
              />
              <input
                className="row-fixed-input"
                type="password"
                autoComplete="off"
                // A stored value as a set password shows, never the value itself (the title says so).
                placeholder={valueStored ? "••••••••" : "Value"}
                title={
                  valueStored
                    ? "Stored on this machine; typing replaces it. The sandbox sees it."
                    : "Stored on this machine, never in tet.json. The sandbox sees it."
                }
                value={row.value}
                onChange={(event) => setVariable({ value: event.target.value })}
              />
            </EditRow>
          );
        }}
        add={
          <ActionLink onClick={() => update("variables", (variables) => [...variables, withId({ env: "", value: "" })])}>
            + Add variable
          </ActionLink>
        }
      />
    );
  }

  return (
    <RowSection
      label="Allowed hosts"
      empty="No hosts allowed yet"
      rows={state.hosts}
      renderRow={(row) => (
        <EditRow key={row.id} remove="Remove host" onRemove={() => update("hosts", (hosts) => without(hosts, row.id))}>
          <input
            className="row-fill-input"
            type="text"
            placeholder="api.example.com"
            title="Exact host, *.example.com, or host:443"
            value={row.host}
            onChange={(event) => update("hosts", (hosts) => patched(hosts, row.id, { host: event.target.value }))}
          />
        </EditRow>
      )}
      add={
        <ActionLink onClick={() => update("hosts", (hosts) => [...hosts, withId({ host: "" })])}>+ Add host</ActionLink>
      }
    />
  );
}
