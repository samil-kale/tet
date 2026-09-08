import type { SbxAccess, SbxAgentId } from "../../shared/types";
import { CloseIcon } from "../ui/icons";
import { Dropdown } from "../ui/Dropdown";

export interface AgentSpec {
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHint: string;
  /** The config-directory row every agent state starts with — mounted read-write no matter
   *  what, see sbx.ts's computeWorkspaces; shown so the user knows it is there. */
  defaultFolder: string;
}

export const AGENT_SPECS: Record<SbxAgentId, AgentSpec> = {
  claude: {
    tokenLabel: "Anthropic API key",
    tokenPlaceholder: "sk-ant-…",
    tokenHint: "Leave blank to sign in with /login inside the sandbox instead.",
    defaultFolder: "~/.claude"
  },
  codex: {
    tokenLabel: "OpenAI API key",
    tokenPlaceholder: "sk-…",
    tokenHint: "Leave blank to authenticate on the host when the sandbox starts.",
    defaultFolder: "~/.codex"
  }
};

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
  /** The agent's config-directory row (`AgentSpec.defaultFolder`): neither its path nor its
   *  access can be changed, and it isn't saved — sbx.ts mounts it on its own. */
  builtin: boolean;
}

export interface AgentState {
  token: string;
  ports: PortRow[];
  folders: FolderRow[];
}

interface EnableSbxFieldsProps {
  agent: SbxAgentId;
  /** Owned by EnableSbxDialog: its Save button needs to read the current values, so the state
   *  lives where the save request is built rather than being lifted out of here after the fact. */
  agentState: AgentState;
  onTokenChange: (value: string) => void;
  onAddPort: () => void;
  onRemovePort: (id: string) => void;
  onUpdatePort: (id: string, change: Partial<PortRow>) => void;
  onAddFolder: () => void;
  onRemoveFolder: (id: string) => void;
  onUpdateFolder: (id: string, change: Partial<FolderRow>) => void;
}

/**
 * One agent's fields, once sbx is installed, signed in, and its network policy is set — see
 * EnableSbxDialog for that part and for where the state lives. Allowed Folders always shows the
 * editable, no-governance form — reading and rendering what an organization's policy actually
 * grants needs `sbx policy ls`'s JSON shape verified against a real governed account first
 * (still open, see the plan).
 */
export function EnableSbxFields({
  agent,
  agentState,
  onTokenChange,
  onAddPort,
  onRemovePort,
  onUpdatePort,
  onAddFolder,
  onRemoveFolder,
  onUpdateFolder
}: EnableSbxFieldsProps) {
  const spec = AGENT_SPECS[agent];
  return (
    <>
      <label className="dialog-field">
        <span>{spec.tokenLabel}</span>
        <input
          type="password"
          value={agentState.token}
          placeholder={spec.tokenPlaceholder}
          onChange={(event) => onTokenChange(event.target.value)}
        />
      </label>
      <p className="dialog-detail">{spec.tokenHint}</p>

      <div className="dialog-field sbx-section">
        <span className="dialog-field-label">Port forwarding</span>
        <div className="sbx-rows">
          {agentState.ports.length === 0 && <p className="dialog-detail">No ports forwarded yet</p>}
          {agentState.ports.map((port) => (
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
          {agentState.folders.map((folder) => (
            <div key={folder.id} className="sbx-folder-row">
              <input
                className="sbx-folder-path"
                type="text"
                value={folder.path}
                readOnly={folder.builtin}
                placeholder="~/path/to/folder or file"
                onChange={(event) => onUpdateFolder(folder.id, { path: event.target.value })}
              />
              {folder.builtin ? (
                // Plain text rather than a Dropdown: the row can't actually make that choice
                // (see FolderRow.builtin), so it must not claim to.
                <span className="sbx-folder-access-fixed">Read+Write</span>
              ) : (
                <Dropdown
                  value={folder.access}
                  options={ACCESS_OPTIONS}
                  onChange={(value) => onUpdateFolder(folder.id, { access: value as SbxAccess })}
                />
              )}
              {!folder.builtin && (
                <button className="icon-button" title="Remove folder" onClick={() => onRemoveFolder(folder.id)}>
                  <CloseIcon />
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="sbx-add-row" onClick={onAddFolder}>
          + Add folder or file
        </button>
      </div>
    </>
  );
}
