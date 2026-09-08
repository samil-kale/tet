import type { SbxAccess, SbxKnowledgeConfig } from "../../shared/types";
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

export interface PortRow {
  id: string;
  host: string;
  container: string;
}

export interface FolderRow {
  id: string;
  path: string;
  access: SbxAccess;
}

export interface FieldsState {
  /** tet.json's `knowledge` — see sbx.ts's knowledgePaths for exactly what each kind mounts. */
  knowledge: SbxKnowledgeConfig;
  ports: PortRow[];
  folders: FolderRow[];
}

interface EnableSbxFieldsProps {
  /** Owned by EnableSbxDialog: its Save button needs to read the current values, so the state
   *  lives where the save request is built rather than being lifted out of here after the fact. */
  state: FieldsState;
  /** `false` turns a kind off; an `SbxAccess` turns it on with that access — the checkbox picks
   *  between off and the last access shown, the dropdown (shown only once on) picks the access. */
  onSetKnowledge: (kind: keyof SbxKnowledgeConfig, value: SbxAccess | false) => void;
  onAddPort: () => void;
  onRemovePort: (id: string) => void;
  onUpdatePort: (id: string, change: Partial<PortRow>) => void;
  onAddFolder: () => void;
  onRemoveFolder: (id: string) => void;
  /** The one thing a folder row can change after being picked — the path itself is what the
   *  native picker returned, shown but not typed over. */
  onSetFolderAccess: (id: string, access: SbxAccess) => void;
}

/**
 * The dialog's fields, once sbx is installed, signed in, and its network policy is set — see
 * EnableSbxDialog for that part and for where the state lives. One set for every sandboxed tab
 * of the project, whichever agent it runs — each sandboxed agent signs in with its own `/login`
 * inside the sandbox, tet holds no credentials for it. Allowed Folders always shows the editable,
 * no-governance form — reading and rendering what an organization's policy actually grants needs
 * `sbx policy ls`'s JSON shape verified against a real governed account first (still open, see
 * the plan).
 */
export function EnableSbxFields({
  state,
  onSetKnowledge,
  onAddPort,
  onRemovePort,
  onUpdatePort,
  onAddFolder,
  onRemoveFolder,
  onSetFolderAccess
}: EnableSbxFieldsProps) {
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
                    onChange={(event) => onSetKnowledge(kind, event.target.checked ? "Read" : false)}
                  />
                  <span>{label}</span>
                </label>
                {access !== false && (
                  <Dropdown value={access} options={ACCESS_OPTIONS} onChange={(value) => onSetKnowledge(kind, value as SbxAccess)} />
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
          {state.ports.map((port) => (
            <div key={port.id} className="sbx-port-row">
              <input
                className="sbx-port-input"
                type="text"
                inputMode="numeric"
                placeholder="3000"
                value={port.host}
                onChange={(event) => onUpdatePort(port.id, { host: event.target.value })}
              />
              <span className="sbx-arrow">→</span>
              <input
                className="sbx-port-input"
                type="text"
                inputMode="numeric"
                placeholder="3000"
                value={port.container}
                onChange={(event) => onUpdatePort(port.id, { container: event.target.value })}
              />
              <button className="icon-button" title="Remove port" onClick={() => onRemovePort(port.id)}>
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="sbx-add-row" onClick={onAddPort}>
          + Add port
        </button>
      </div>

      <div className="dialog-field sbx-section">
        <span className="dialog-field-label">Allowed folders</span>
        <div className="sbx-rows">
          {state.folders.length === 0 && <p className="dialog-detail">No folders shared yet</p>}
          {state.folders.map((folder) => (
            <div key={folder.id} className="sbx-folder-row">
              <span className="sbx-folder-path" title={folder.path}>
                {folder.path}
              </span>
              <Dropdown
                value={folder.access}
                options={ACCESS_OPTIONS}
                onChange={(value) => onSetFolderAccess(folder.id, value as SbxAccess)}
              />
              <button className="icon-button" title="Remove folder" onClick={() => onRemoveFolder(folder.id)}>
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        {/* Folders only: sbx refuses a single file ("workspace path exists but is not a
            directory", verified live 2026-09-08). */}
        <button type="button" className="sbx-add-row" onClick={onAddFolder}>
          + Add folder
        </button>
      </div>
    </>
  );
}
