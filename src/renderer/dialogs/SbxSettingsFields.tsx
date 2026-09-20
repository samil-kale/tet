import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { SbxAccess, SbxKnowledgeConfig, SbxPath, SbxPort, SbxProjectConfig } from "../../shared/types";
import { CircleAlertIcon, CloseIcon } from "../ui/icons";
import { ActionLink } from "../ui/ActionLink";
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
  { kind: "instructions", label: "Instructions file (CLAUDE.md / AGENTS.md)" }
];

/** How long typing in a secret's hosts pauses before they are checked against sbx's policy. */
const HOST_CHECK_DELAY_MS = 500;

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

/** The two things every section does to one of its rows, by the id `withId` gave it. */
function patched<T extends { id: string }>(rows: T[], id: string, change: Partial<T>): T[] {
  return rows.map((entry) => (entry.id === id ? { ...entry, ...change } : entry));
}

function without<T extends { id: string }>(rows: T[], id: string): T[] {
  return rows.filter((entry) => entry.id !== id);
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

/** A secret row Save refuses (an empty one is dropped): it needs a variable name of its own and
 *  hosts, none of them bad (isBadHost). */
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
    hosts.some(isBadHost)
  );
}

/** A scheme or port, which `sbx secret set-custom` rejects (measured), or a leading "-", which sbx
 *  would read as an option of its own. */
function isBadHost(host: string): boolean {
  return /^-|[/:]/.test(host);
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
    secrets: first(state.secrets.map((row) => secretMark(row, state.secrets, answers, governed)))
  };
}

/** A row's mark, in every tab right before the row's remove button; nothing without a reason. */
function RowMark({ title }: { title: string | undefined }) {
  return title === undefined ? null : (
    <span className="sbx-path-denied" title={title}>
      <CircleAlertIcon />
    </span>
  );
}

/** Every row's last cell. */
function RemoveRow({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button className="icon-button" title={title} onClick={onClick}>
      <CloseIcon />
    </button>
  );
}

/**
 * The box a section's rows sit in: its label, the rows or a line saying there are none, and what
 * adds one underneath.
 */
function RowSection<T extends { id: string }>({
  label,
  empty,
  rows,
  renderRow,
  add
}: {
  label: string;
  empty: string;
  rows: T[];
  renderRow: (row: T) => ReactNode;
  add: ReactNode;
}) {
  return (
    <div className="dialog-field">
      <span className="dialog-field-label">{label}</span>
      <div className="sbx-rows">
        {rows.length === 0 && <p className="dialog-detail">{empty}</p>}
        {rows.map(renderRow)}
      </div>
      {add}
    </div>
  );
}

interface SbxSettingsFieldsProps {
  /** Owned by SbxSettingsDialog, which builds the save request. */
  state: FieldsState;
  setState: Dispatch<SetStateAction<FieldsState>>;
  section: keyof FieldsState;
  /** An organization manages sbx's policy; only words the paths' and secrets' marks. */
  governed: boolean;
  /** The env names holding a value on this machine (`sbx:stored-secrets`). */
  storedSecrets: readonly string[];
  /** Asked by the dialog from its opening (usePolicyAnswers), for the tabs' marks too. */
  answers: PolicyAnswers;
}

/** One tab of the dialog's fields, shown once sbx is ready (see SbxSettingsDialog). State is
 *  shared across tabs. */
export function SbxSettingsFields({ state, setState, section, governed, storedSecrets, answers }: SbxSettingsFieldsProps) {
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
                <Checkbox
                  label={label}
                  checked={access !== false}
                  onChange={(next) => setKnowledge(kind, next ? "ro" : false)}
                />
                {access !== false && (
                  <Dropdown value={access} options={ACCESS_OPTIONS} onChange={(value) => setKnowledge(kind, value)} />
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
      <RowSection
        label="Port forwarding"
        empty="No ports forwarded yet"
        rows={state.ports}
        renderRow={(port) => {
          const setPort = (change: Partial<typeof port>): void =>
            update("ports", (ports) => patched(ports, port.id, change));
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
              <RowMark title={isBadPortRow(port) ? BAD_PORT : undefined} />
              <RemoveRow title="Remove port" onClick={() => update("ports", (ports) => without(ports, port.id))} />
            </div>
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
          <div key={row.id} className="sbx-path-row">
            {/* Plain text: the path is what the picker returned. */}
            <span className="sbx-path-value" title={row.path}>
              {row.path}
            </span>
            <Dropdown
              value={row.access}
              options={ACCESS_OPTIONS}
              onChange={(access) => update("paths", (paths) => patched(paths, row.id, { access }))}
            />
            <RowMark title={pathMark(row, answers, governed)} />
            <RemoveRow title="Remove path" onClick={() => update("paths", (paths) => without(paths, row.id))} />
          </div>
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
                // A stored value as a set password shows, never the value itself (the title says so).
                placeholder={stored ? "••••••••" : "Value"}
                title={
                  stored
                    ? "Stored on this machine; typing replaces it. The sandbox never sees it."
                    : "Stored on this machine, never in tet.json. The sandbox never sees it."
                }
                value={row.value}
                onChange={(event) => setSecret({ value: event.target.value })}
              />
              <RowMark title={secretMark(row, state.secrets, answers, governed)} />
              <RemoveRow title="Remove secret" onClick={() => update("secrets", (secrets) => without(secrets, row.id))} />
            </div>
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

  return (
    <RowSection
      label="Allowed hosts"
      empty="No hosts allowed yet"
      rows={state.hosts}
      renderRow={(row) => (
        // The path row's box: the input's flex: 1 pushes the button right, as .sbx-path-value does.
        <div key={row.id} className="sbx-path-row">
          <input
            className="sbx-host-input"
            type="text"
            placeholder="api.example.com"
            title="Exact host, *.example.com, or host:443"
            value={row.host}
            onChange={(event) => update("hosts", (hosts) => patched(hosts, row.id, { host: event.target.value }))}
          />
          <RemoveRow title="Remove host" onClick={() => update("hosts", (hosts) => without(hosts, row.id))} />
        </div>
      )}
      add={
        <ActionLink onClick={() => update("hosts", (hosts) => [...hosts, withId({ host: "" })])}>+ Add host</ActionLink>
      }
    />
  );
}
