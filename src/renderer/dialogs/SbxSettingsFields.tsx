import type { Dispatch, SetStateAction } from "react";
import type { SbxAccess, SbxKnowledgeConfig, SbxPath, SbxPort, SbxProjectConfig } from "../../shared/types";
import { CloseIcon } from "../ui/icons";
import { Dropdown } from "../ui/Dropdown";

const ACCESS_OPTIONS: { value: SbxAccess; label: string }[] = [
  { value: "Read", label: "Read" },
  { value: "Read+Write", label: "Read+Write" }
];

/** One row per `SbxKnowledgeConfig` kind, in the order shown — labels only, the actual host
 *  paths are sbx.ts's `knowledgePaths`, which differ per agent and are never the dialog's
 *  concern. */
const KNOWLEDGE_LABELS: { kind: keyof SbxKnowledgeConfig; label: string }[] = [
  { kind: "skills", label: "Skills" },
  { kind: "plugins", label: "Plugins" },
  { kind: "instructions", label: "Instructions file (CLAUDE.md / AGENTS.md)" }
];

/** A port or allowed-path row as the fields hold it: the saved shape plus a local id for its
 *  React key, never sent anywhere. */
type Row<T> = T & { id: string };

export interface FieldsState {
  /** tet.json's `knowledge` — see sbx.ts's knowledgePaths for exactly what each kind mounts. */
  knowledge: SbxKnowledgeConfig;
  ports: Row<SbxPort>[];
  paths: Row<SbxPath>[];
}

let nextRowId = 0;
function withId<T>(row: T): Row<T> {
  nextRowId += 1;
  return { ...row, id: `row-${nextRowId}` };
}

/**
 * `sbx:get-config`'s answer turned into the fields' own row shape. Only the user's own paths —
 * each agent's config directory and tet's own directories are mounted whatever this list says
 * (sbx.ts's computeWorkspaces) and deliberately not shown as rows: nothing about them is the
 * user's to change.
 */
export function fromConfig(config: SbxProjectConfig): FieldsState {
  return { knowledge: config.knowledge, ports: config.ports.map(withId), paths: config.paths.map(withId) };
}

/** The inverse, for Save: ids dropped, and a port row left half-empty dropped with them. */
export function toConfig(state: FieldsState): Omit<SbxProjectConfig, "enabled"> {
  return {
    knowledge: state.knowledge,
    ports: state.ports.filter((port) => port.host.trim() && port.container.trim()).map(({ host, container }) => ({ host, container })),
    paths: state.paths.map(({ path, access }) => ({ path, access }))
  };
}

interface SbxSettingsFieldsProps {
  /** Owned by SbxSettingsDialog, whose Save button reads the current values — so the state lives
   *  where the save request is built, and this only edits it. */
  state: FieldsState;
  setState: Dispatch<SetStateAction<FieldsState>>;
}

/**
 * The dialog's fields, once sbx is installed, signed in, and its network policy is set — see
 * SbxSettingsDialog for that part and for where the state lives. One set for every sandboxed tab
 * of the project, whichever agent it runs — each sandboxed agent signs in with its own `/login`
 * inside the sandbox, tet holds no credentials for it. Allowed paths always shows the editable,
 * no-governance form — reading and rendering what an organization's policy actually grants needs
 * `sbx policy ls`'s JSON shape verified against a real governed account first, and none was
 * available to test with.
 */
export function SbxSettingsFields({ state, setState }: SbxSettingsFieldsProps) {
  const update = <K extends keyof FieldsState>(key: K, change: (value: FieldsState[K]) => FieldsState[K]): void =>
    setState((current) => ({ ...current, [key]: change(current[key]) }));

  /** `false` turns a kind off; an `SbxAccess` turns it on with that access — the checkbox picks
   *  between off and Read, the dropdown (shown only once on) picks the access. */
  const setKnowledge = (kind: keyof SbxKnowledgeConfig, value: SbxAccess | false): void =>
    update("knowledge", (knowledge) => ({ ...knowledge, [kind]: value }));
  /** The native picker, the way the add-repository dialog asks for a directory — a cancelled
   *  pick adds nothing, and a picked path is not typed over afterwards. A folder and a file are
   *  two buttons rather than one picker because Electron only shows both kinds in one dialog on
   *  macOS (see the `projects:pick-file` handler); sbx mounts either the same way. */
  const addPath = async (picked: Promise<string | null>): Promise<void> => {
    const chosen = await picked;
    if (chosen) {
      update("paths", (paths) => [...paths, withId({ path: chosen, access: "Read+Write" })]);
    }
  };

  return (
    <>
      <div className="dialog-field sbx-section">
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
                    onChange={(event) => setKnowledge(kind, event.target.checked ? "Read" : false)}
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

      <div className="dialog-field sbx-section">
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

      <div className="dialog-field sbx-section">
        <span className="dialog-field-label">Allowed paths</span>
        <div className="sbx-rows">
          {state.paths.length === 0 && <p className="dialog-detail">No paths shared yet</p>}
          {state.paths.map((row) => (
            <div key={row.id} className="sbx-path-row">
              {/* Plain text, not an input: the path is what the picker returned, shown but not
                  typed over — the access dropdown is the one thing a row can change. */}
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
    </>
  );
}
