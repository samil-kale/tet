import type { Dispatch, SetStateAction } from "react";
import type { SbxAccess, SbxKnowledgeConfig, SbxPath, SbxPort, SbxProjectConfig } from "../../shared/types";
import { CloseIcon } from "../ui/icons";
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
    hosts: config.hosts.map((host) => withId({ host }))
  };
}

/** The inverse, for Save: ids dropped, as are half-empty port rows and empty host rows. */
export function toConfig(state: FieldsState): Omit<SbxProjectConfig, "enabled"> {
  return {
    knowledge: state.knowledge,
    ports: state.ports.filter((port) => port.host.trim() && port.container.trim()).map(({ host, container }) => ({ host, container })),
    paths: state.paths.map(({ path, access }) => ({ path, access })),
    hosts: state.hosts.map(({ host }) => host.trim()).filter(Boolean)
  };
}

interface SbxSettingsFieldsProps {
  /** Owned by SbxSettingsDialog, which builds the save request. */
  state: FieldsState;
  setState: Dispatch<SetStateAction<FieldsState>>;
  section: keyof FieldsState;
}

/** One tab of the dialog's fields, shown once sbx is ready (see SbxSettingsDialog). State is
 *  shared across tabs. */
export function SbxSettingsFields({ state, setState, section }: SbxSettingsFieldsProps) {
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
