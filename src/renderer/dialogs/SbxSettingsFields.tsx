import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { SbxAccess, SbxKnowledgeConfig, SbxPath, SbxPort, SbxProjectConfig } from "../../shared/types";
import { CloseIcon, ExclamationIcon } from "../ui/icons";
import { Dropdown } from "../ui/Dropdown";

const ACCESS_OPTIONS: { value: SbxAccess; label: string }[] = [
  { value: "ro", label: "Read" },
  { value: "rw", label: "Read+Write" }
];

/** One row per `SbxKnowledgeConfig` kind, in display order. Labels only; the per-agent host paths
 *  are `AgentDefinition.sandboxKnowledge`. */
const KNOWLEDGE_LABELS: { kind: keyof SbxKnowledgeConfig; label: string }[] = [
  { kind: "skills", label: "Skills" },
  { kind: "plugins", label: "Plugins" },
  { kind: "instructions", label: "Instructions file (CLAUDE.md / AGENTS.md)" }
];

/** A row as the fields hold it: the saved shape plus a local React key, never sent anywhere. */
type Row<T> = T & { id: string };

export interface FieldsState {
  /** tet.json's `knowledge`; what each kind mounts is `AgentDefinition.sandboxKnowledge`. */
  knowledge: SbxKnowledgeConfig;
  ports: Row<SbxPort>[];
  paths: Row<SbxPath>[];
  hosts: Row<{ host: string }>[];
  /** `hosts` as typed, comma-separated; `value` only what was typed since opening — a stored one
   *  never reaches the renderer. */
  secrets: Row<{ env: string; hosts: string; value: string }>[];
}

let nextRowId = 0;
function withId<T>(row: T): Row<T> {
  nextRowId += 1;
  return { ...row, id: `row-${nextRowId}` };
}

/** `sbx:get-config`'s answer as rows. Only the user's paths: tet's directories and each agent's
 *  session directory are always mounted (sbx.ts's fixedMountSpecs, sessionMountSpecs), not shown. */
export function fromConfig(config: SbxProjectConfig): FieldsState {
  return {
    knowledge: config.knowledge,
    ports: config.ports.map(withId),
    paths: config.paths.map(withId),
    hosts: config.hosts.map((host) => withId({ host })),
    secrets: config.secrets.map((secret) => withId({ env: secret.env, hosts: secret.hosts.join(", "), value: "" }))
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

/** A secret row Save refuses — an empty one is dropped. It needs an environment variable name,
 *  once, and hosts without scheme or port, which `sbx secret set-custom` rejects (measured). */
function isBadSecretRow(row: SecretRow, rows: SecretRow[]): boolean {
  if (isEmptySecretRow(row)) {
    return false;
  }
  const env = row.env.trim();
  const hosts = secretHosts(row);
  return (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env) ||
    rows.some((other) => other.id !== row.id && other.env.trim() === env) ||
    hosts.length === 0 ||
    hosts.some((host) => /[/:]/.test(host))
  );
}

/** Why Save waits, or `undefined`: every port row two ports or empty, every secret row complete or
 *  empty. The rows mark which is not. */
export function saveBlocked(state: FieldsState): string | undefined {
  if (state.ports.some(isBadPortRow)) {
    return "A port on the Ports tab is not a whole number from 1 to 65535";
  }
  if (state.secrets.some((row) => isBadSecretRow(row, state.secrets))) {
    return "A secret on the Secrets tab needs a variable name of its own and hosts without scheme or port";
  }
  return undefined;
}

/** The inverse, for Save: ids dropped, as are empty port, host and secret rows. */
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
      .map((row) => ({ env: row.env.trim(), hosts: secretHosts(row) }))
  };
}

/** The secret values typed since opening, by env name, for Save to store on this machine. */
export function toSecretValues(state: FieldsState): Record<string, string> {
  return Object.fromEntries(state.secrets.filter((row) => row.value !== "").map((row) => [row.env.trim(), row.value]));
}

interface SbxSettingsFieldsProps {
  /** Owned by SbxSettingsDialog, which builds the save request. */
  state: FieldsState;
  setState: Dispatch<SetStateAction<FieldsState>>;
  section: keyof FieldsState;
  /** An organization manages sbx's policy; only words the Allowed paths marks. */
  governed: boolean;
  /** The env names holding a value on this machine (`sbx:stored-secrets`). */
  storedSecrets: readonly string[];
}

/** One tab of the dialog's fields, shown once sbx is ready (see SbxSettingsDialog). State is
 *  shared across tabs. */
export function SbxSettingsFields({ state, setState, section, governed, storedSecrets }: SbxSettingsFieldsProps) {
  /** Row ids of Allowed paths sbx's policy would refuse to mount (sbx.ts's readMountsAllowed). */
  const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set());
  // Only a changed path or access asks again; an answer overtaken by an edit is dropped.
  const pathsKey = JSON.stringify(state.paths.map(({ id, path, access }) => [id, path, access]));
  useEffect(() => {
    if (section !== "paths" || state.paths.length === 0) {
      return;
    }
    const rows = state.paths;
    let current = true;
    void window.tet.sbx.mountsAllowed(rows.map(({ path, access }) => ({ path, access }))).then((allowed) => {
      if (current) {
        setDenied(new Set(rows.filter((_row, index) => !allowed[index]).map((row) => row.id)));
      }
    });
    return () => {
      current = false;
    };
  }, [section, pathsKey]);

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
            const access = state.knowledge[kind];
            return (
              <div key={kind} className="sbx-knowledge-row">
                <label className="dialog-checkbox">
                  <input
                    type="checkbox"
                    checked={access !== false}
                    onChange={(event) => setKnowledge(kind, event.target.checked ? "ro" : false)}
                  />
                  <span>{label}</span>
                </label>
                {access !== false && (
                  <Dropdown value={access} options={ACCESS_OPTIONS} onChange={(value) => setKnowledge(kind, value as SbxAccess)} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (section === "ports") {
    return (
      <div className="dialog-field">
        <span className="dialog-field-label">Port forwarding</span>
        <div className="sbx-rows">
          {state.ports.length === 0 && <p className="dialog-detail">No ports forwarded yet</p>}
          {state.ports.map((port) => {
            const setPort = (change: Partial<typeof port>): void =>
              update("ports", (ports) => ports.map((entry) => (entry.id === port.id ? { ...entry, ...change } : entry)));
            return (
              <div key={port.id} className="sbx-port-row">
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
                {isBadPortRow(port) && (
                  // The Allowed paths mark, for a row Save refuses.
                  <span className="sbx-path-denied" title="Both ports must be whole numbers from 1 to 65535">
                    <ExclamationIcon />
                  </span>
                )}
                <button
                  className="icon-button"
                  title="Remove port"
                  onClick={() => update("ports", (ports) => ports.filter((entry) => entry.id !== port.id))}
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="sbx-add-row"
          onClick={() => update("ports", (ports) => [...ports, withId({ host: "", container: "" })])}
        >
          + Add port
        </button>
      </div>
    );
  }

  if (section === "paths") {
    return (
      <div className="dialog-field">
        <span className="dialog-field-label">Allowed paths</span>
        <div className="sbx-rows">
          {state.paths.length === 0 && <p className="dialog-detail">No paths shared yet</p>}
          {state.paths.map((row) => (
            <div key={row.id} className="sbx-path-row">
              {/* Plain text: the path is what the picker returned. */}
              <span className="sbx-path-value" title={row.path}>
                {row.path}
              </span>
              {denied.has(row.id) && (
                <span
                  className="sbx-path-denied"
                  title={`${governed ? "Your organization's SBX policy" : "SBX's policy"} does not allow mounting this path${row.access === "rw" ? " with write access" : ""}`}
                >
                  <ExclamationIcon />
                </span>
              )}
              <Dropdown
                value={row.access}
                options={ACCESS_OPTIONS}
                onChange={(value) =>
                  update("paths", (paths) => paths.map((entry) => (entry.id === row.id ? { ...entry, access: value as SbxAccess } : entry)))
                }
              />
              <button
                className="icon-button"
                title="Remove path"
                onClick={() => update("paths", (paths) => paths.filter((entry) => entry.id !== row.id))}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        <div className="sbx-add-paths">
          <button
            type="button"
            className="sbx-add-row"
            onClick={() => void addPath(window.tet.projects.pickDirectory("Allow a folder in the sandbox"))}
          >
            + Add folder
          </button>
          <button type="button" className="sbx-add-row" onClick={() => void addPath(window.tet.projects.pickFile("Allow a file in the sandbox"))}>
            + Add file
          </button>
        </div>
      </div>
    );
  }

  if (section === "secrets") {
    return (
      <div className="dialog-field">
        <span className="dialog-field-label">Secrets</span>
        <div className="sbx-rows">
          {state.secrets.length === 0 && <p className="dialog-detail">No secrets yet</p>}
          {state.secrets.map((row) => {
            const setSecret = (change: Partial<typeof row>): void =>
              update("secrets", (secrets) => secrets.map((entry) => (entry.id === row.id ? { ...entry, ...change } : entry)));
            const stored = storedSecrets.includes(row.env.trim());
            return (
              // The path row's box, as the host rows.
              <div key={row.id} className="sbx-path-row">
                <input
                  className="sbx-secret-input"
                  type="text"
                  placeholder="GITLAB_TOKEN"
                  title="The environment variable the sandbox sees, holding a placeholder instead of the value"
                  value={row.env}
                  onChange={(event) => setSecret({ env: event.target.value })}
                />
                <input
                  className="sbx-host-input"
                  type="text"
                  placeholder="gitlab.example.com"
                  title="Where sbx puts the value in place of the placeholder, in request headers only: exact host or *.example.com, comma-separated, no scheme or port"
                  value={row.hosts}
                  onChange={(event) => setSecret({ hosts: event.target.value })}
                />
                <input
                  className="sbx-secret-input"
                  type="password"
                  autoComplete="off"
                  placeholder={stored ? "Unchanged" : "Value"}
                  title={
                    stored
                      ? "Stored on this machine; typing replaces it. The sandbox never sees it."
                      : "Stored on this machine, never in tet.json. The sandbox never sees it."
                  }
                  value={row.value}
                  onChange={(event) => setSecret({ value: event.target.value })}
                />
                {isBadSecretRow(row, state.secrets) && (
                  // The Allowed paths mark, for a row Save refuses.
                  <span className="sbx-path-denied" title="Needs a variable name of its own and hosts without scheme or port">
                    <ExclamationIcon />
                  </span>
                )}
                <button
                  className="icon-button"
                  title="Remove secret"
                  onClick={() => update("secrets", (secrets) => secrets.filter((entry) => entry.id !== row.id))}
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="sbx-add-row"
          onClick={() => update("secrets", (secrets) => [...secrets, withId({ env: "", hosts: "", value: "" })])}
        >
          + Add secret
        </button>
      </div>
    );
  }

  return (
    <div className="dialog-field">
      <span className="dialog-field-label">Allowed hosts</span>
      <div className="sbx-rows">
        {state.hosts.length === 0 && <p className="dialog-detail">No hosts allowed yet</p>}
        {state.hosts.map((row) => (
          // The path row's box: the input's flex: 1 pushes the button right, as .sbx-path-value does.
          <div key={row.id} className="sbx-path-row">
            <input
              className="sbx-host-input"
              type="text"
              placeholder="api.example.com"
              title="Exact host, *.example.com, or host:443"
              value={row.host}
              onChange={(event) =>
                update("hosts", (hosts) => hosts.map((entry) => (entry.id === row.id ? { ...entry, host: event.target.value } : entry)))
              }
            />
            <button
              className="icon-button"
              title="Remove host"
              onClick={() => update("hosts", (hosts) => hosts.filter((entry) => entry.id !== row.id))}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="sbx-add-row" onClick={() => update("hosts", (hosts) => [...hosts, withId({ host: "" })])}>
        + Add host
      </button>
    </div>
  );
}
