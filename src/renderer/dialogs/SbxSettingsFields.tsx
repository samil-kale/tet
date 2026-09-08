import type { Dispatch, SetStateAction } from "react";
import type { SbxAccess, SbxFolder, SbxKnowledgeConfig, SbxPort, SbxProjectConfig } from "../../shared/types";
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

/** A port or folder row as the fields hold it: the saved shape plus a local id for its React
 *  key, never sent anywhere. */
type Row<T> = T & { id: string };

export interface FieldsState {
  /** tet.json's `knowledge` — see sbx.ts's knowledgePaths for exactly what each kind mounts. */
  knowledge: SbxKnowledgeConfig;
  ports: Row<SbxPort>[];
  folders: Row<SbxFolder>[];
}

let nextRowId = 0;
function withId<T>(row: T): Row<T> {
  nextRowId += 1;
  return { ...row, id: `row-${nextRowId}` };
}

/**
 * `sbx:get-config`'s answer turned into the fields' own row shape. Only the user's own folders —
 * each agent's config directory and tet's own directories are mounted whatever this list says
 * (sbx.ts's computeWorkspaces) and deliberately not shown as rows: nothing about them is the
 * user's to change.
 */
export function fromConfig(config: SbxProjectConfig): FieldsState {
  return { knowledge: config.knowledge, ports: config.ports.map(withId), folders: config.folders.map(withId) };
}

/** The inverse, for Save: ids dropped, and a port row left half-empty dropped with them. */
export function toConfig(state: FieldsState): Omit<SbxProjectConfig, "enabled"> {
  return {
    knowledge: state.knowledge,
    ports: state.ports.filter((port) => port.host.trim() && port.container.trim()).map(({ host, container }) => ({ host, container })),
    folders: state.folders.map(({ path, access }) => ({ path, access }))
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
 * inside the sandbox, tet holds no credentials for it. Allowed Folders always shows the editable,
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
  /** The native folder picker, the way the add-repository dialog asks for a directory — a
   *  cancelled pick adds nothing, and a picked path is not typed over afterwards. */
  const addFolder = async (): Promise<void> => {
    const picked = await window.tet.projects.pickDirectory("Allow a folder in the sandbox");
    if (picked) {
      update("folders", (folders) => [...folders, withId({ path: picked, access: "Read+Write" })]);
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
        <span className="dialog-field-label">Allowed folders</span>
        <div className="sbx-rows">
          {state.folders.length === 0 && <p className="dialog-detail">No folders shared yet</p>}
          {state.folders.map((folder) => (
            <div key={folder.id} className="sbx-folder-row">
              {/* Plain text, not an input: the path is what the picker returned, shown but not
                  typed over — the access dropdown is the one thing a row can change. */}
              <span className="sbx-folder-path" title={folder.path}>
                {folder.path}
              </span>
              <Dropdown
                value={folder.access}
                options={ACCESS_OPTIONS}
                onChange={(value) =>
                  update("folders", (folders) =>
                    folders.map((entry) => (entry.id === folder.id ? { ...entry, access: value as SbxAccess } : entry))
                  )
                }
              />
              <button
                className="icon-button"
                title="Remove folder"
                onClick={() => update("folders", (folders) => folders.filter((entry) => entry.id !== folder.id))}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        {/* Folders only: sbx refuses a single file ("workspace path exists but is not a
            directory", verified live 2026-09-08). */}
        <button type="button" className="sbx-add-row" onClick={() => void addFolder()}>
          + Add folder
        </button>
      </div>
    </>
  );
}
