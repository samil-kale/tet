import { SBX_AGENT_IDS } from "../../shared/types";
import type { SbxAccess, SbxAgentId } from "../../shared/types";
import { CloseIcon } from "../ui/icons";
import { Dropdown } from "../ui/Dropdown";

/** The one thing that is per agent in this dialog: its API key, since `sbx secret set` is per
 *  service (see sbx.ts's SANDBOX_SERVICE). Everything else — ports, folders — is the project's. */
interface TokenSpec {
  label: string;
  placeholder: string;
}

const TOKEN_SPECS: Record<SbxAgentId, TokenSpec> = {
  claude: { label: "Anthropic API key (Claude)", placeholder: "sk-ant-…" },
  codex: { label: "OpenAI API key (Codex)", placeholder: "sk-…" }
};

/** One hint for both fields, under the last one. Deliberately names no way of signing in: they
 *  differ per agent (Claude's /login inside the sandbox, Codex's on the host), and the agent
 *  itself says which when it starts without a key. */
const TOKEN_HINT = "Leave blank to sign in when the sandbox starts.";

const ACCESS_OPTIONS: { value: SbxAccess; label: string }[] = [
  { value: "Read", label: "Read" },
  { value: "Read+Write", label: "Read+Write" }
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
  tokens: Record<SbxAgentId, string>;
  ports: PortRow[];
  folders: FolderRow[];
}

interface EnableSbxFieldsProps {
  /** Owned by EnableSbxDialog: its Save button needs to read the current values, so the state
   *  lives where the save request is built rather than being lifted out of here after the fact. */
  state: FieldsState;
  onTokenChange: (agent: SbxAgentId, value: string) => void;
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
 * of the project, whichever agent it runs; only the API keys are per agent, stacked. Allowed
 * Folders always shows the editable, no-governance form — reading and rendering what an
 * organization's policy actually grants needs `sbx policy ls`'s JSON shape verified against a
 * real governed account first (still open, see the plan).
 */
export function EnableSbxFields({
  state,
  onTokenChange,
  onAddPort,
  onRemovePort,
  onUpdatePort,
  onAddFolder,
  onRemoveFolder,
  onSetFolderAccess
}: EnableSbxFieldsProps) {
  return (
    <>
      {SBX_AGENT_IDS.map((agent) => (
        <label key={agent} className="dialog-field">
          <span>{TOKEN_SPECS[agent].label}</span>
          <input
            type="password"
            value={state.tokens[agent]}
            placeholder={TOKEN_SPECS[agent].placeholder}
            onChange={(event) => onTokenChange(agent, event.target.value)}
          />
        </label>
      ))}
      <p className="dialog-detail">{TOKEN_HINT}</p>

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
