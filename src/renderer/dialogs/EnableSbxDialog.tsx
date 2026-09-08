import { useEffect, useRef, useState } from "react";
import type { Project, SbxAgentConfig, SbxAgentId, SbxAgentSave, SbxFixedPaths, SbxSaveRequest } from "../../shared/types";
import { AGENT_SPECS, EnableSbxFields, type AgentSpec, type AgentState, type FolderRow, type PortRow } from "./EnableSbxFields";
import { CloseIcon } from "../ui/icons";
import { notify } from "../ui/Notices";
import { ProgressBar } from "../ui/ProgressBar";
import { useEscape } from "../ui/use-escape";

const TABS: { id: SbxAgentId; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" }
];

/** Docker's own install page — the "Get it" button, same as RequirementsDialog's per program. */
const SBX_INSTALL_URL = "https://docs.docker.com/ai/sandboxes/install/";

interface EnableSbxDialogProps {
  project: Project;
  onClose: () => void;
}

type Phase =
  | { kind: "checking" }
  | { kind: "not-installed" }
  | { kind: "signing-in" }
  | { kind: "initializing-policy" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

/** Placeholder for the initial render, before `sbx:get-config` has answered — the fixed rows
 *  built from this are never shown, since the fields only render once phase.kind is "ready". */
const EMPTY_FIXED_PATHS: SbxFixedPaths = { agentDir: "", contextDir: "" };

let nextRowId = 0;
/** Local-only id for a port/folder row's React key — never sent anywhere. */
function newRowId(): string {
  nextRowId += 1;
  return `row-${nextRowId}`;
}

/** The rows computeWorkspaces mounts unconditionally, never from tet.json: the agent's own config
 *  directory, then the two SbxFixedPaths (see there for what each is and why it's shown). */
function fixedFolders(spec: AgentSpec, fixedPaths: SbxFixedPaths): FolderRow[] {
  return [
    { id: newRowId(), path: spec.defaultFolder, access: "Read+Write", builtin: true },
    { id: newRowId(), path: fixedPaths.agentDir, access: "Read+Write", builtin: true },
    { id: newRowId(), path: fixedPaths.contextDir, access: "Read", builtin: true }
  ];
}

/**
 * `sbx:get-config`'s answer (or nothing yet), turned into this dialog's own row shape: each row
 * gets a local id for its React key, and the builtin rows always come first — never from
 * tet.json, which `toSaveAgent` keeps them out of, but a file written by hand may still hold one
 * of their paths, so a saved row matching any of them is dropped rather than shown twice.
 */
function hydrateAgentState(spec: AgentSpec, saved: SbxAgentConfig | undefined, fixedPaths: SbxFixedPaths): AgentState {
  const builtinPaths = new Set([spec.defaultFolder, fixedPaths.agentDir, fixedPaths.contextDir]);
  const folders = (saved?.folders ?? [])
    .filter((folder) => !builtinPaths.has(folder.path))
    .map((folder) => ({ id: newRowId(), path: folder.path, access: folder.access, builtin: false }));
  return {
    token: "",
    ports: (saved?.ports ?? []).map((port) => ({ id: newRowId(), host: port.host, container: port.container })),
    folders: [...fixedFolders(spec, fixedPaths), ...folders]
  };
}

function toSaveAgent(state: AgentState): SbxAgentSave {
  return {
    token: state.token,
    ports: state.ports.filter((port) => port.host.trim() && port.container.trim()).map(({ host, container }) => ({ host, container })),
    folders: state.folders.filter((folder) => !folder.builtin && folder.path.trim()).map(({ path, access }) => ({ path, access }))
  };
}

/**
 * The one dialog for the whole sbx open path and its configuration — installed or not, signed in
 * or not, network policy set or not, this is where it all shows, not scattered across notices.
 *
 * Runs its own setup once mounted: check sbx is installed, check sign-in, sign in in the
 * background if needed (`sbx login` opens the OAuth page in the browser itself), check the
 * machine-wide network policy, initialize it (to "balanced") if needed — see the plan for why
 * that one is a background default rather than a per-project dialog choice. Each step shows in
 * the title bar's own progress bar (`.enable-sbx-bar`, the same shape as the diff dialog's
 * `.diff-dialog-bar` — see "One progress indicator per pane" in CLAUDE.md) so the click is never
 * followed by nothing happening. Installing is not a step: the same rule as RequirementsDialog,
 * no command works on all three platforms, so a missing sbx gets Docker's install page and a
 * "Check again".
 *
 * Token/ports/folders live here, not in EnableSbxFields, for the same reason the tab bar does:
 * Save (the footer button, once ready) needs to read the current values to build the request it
 * sends to `sbx:save-config` — session-manager.ts's `resolveSbxRun` is what actually acts on
 * what gets saved, the next time a claude/codex tab in this project spawns.
 */
export function EnableSbxDialog({ project, onClose }: EnableSbxDialogProps) {
  // One way out, whichever of × / Escape / Cancel triggers it: `cancelSbxSetup` is a no-op when
  // nothing is running, so this is safe to call every time, not just from the Cancel button.
  const close = (): void => {
    window.tet.sbx.cancelSetup();
    onClose();
  };
  useEscape(close);
  const [enabled, setEnabled] = useState(false);
  const [tab, setTab] = useState<SbxAgentId>("claude");
  const [state, setState] = useState<Record<SbxAgentId, AgentState>>({
    claude: hydrateAgentState(AGENT_SPECS.claude, undefined, EMPTY_FIXED_PATHS),
    codex: hydrateAgentState(AGENT_SPECS.codex, undefined, EMPTY_FIXED_PATHS)
  });
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  // So a step that resolves after the dialog closed doesn't set state on an unmounted component.
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const patch = (agent: SbxAgentId, change: Partial<AgentState>): void =>
    setState((current) => ({ ...current, [agent]: { ...current[agent], ...change } }));

  const addPort = (agent: SbxAgentId): void =>
    patch(agent, { ports: [...state[agent].ports, { id: newRowId(), host: "", container: "" }] });
  const removePort = (agent: SbxAgentId, id: string): void =>
    patch(agent, { ports: state[agent].ports.filter((port) => port.id !== id) });
  const updatePort = (agent: SbxAgentId, id: string, change: Partial<PortRow>): void =>
    patch(agent, { ports: state[agent].ports.map((port) => (port.id === id ? { ...port, ...change } : port)) });
  const addFolder = (agent: SbxAgentId): void =>
    patch(agent, {
      folders: [...state[agent].folders, { id: newRowId(), path: "", access: "Read+Write", builtin: false }]
    });
  const removeFolder = (agent: SbxAgentId, id: string): void =>
    patch(agent, { folders: state[agent].folders.filter((folder) => folder.id !== id) });
  const updateFolder = (agent: SbxAgentId, id: string, change: Partial<FolderRow>): void =>
    patch(agent, {
      folders: state[agent].folders.map((folder) => (folder.id === id ? { ...folder, ...change } : folder))
    });

  /** Installed → signed in → policy → saved config. Run on mount and by "Check again". */
  const setup = async (): Promise<void> => {
    setPhase({ kind: "checking" });
    const installed = await window.tet.sbx.checkInstalled();
    if (!live.current) {
      return;
    }
    if (!installed) {
      setPhase({ kind: "not-installed" });
      return;
    }
    const loggedIn = await window.tet.sbx.checkLoggedIn();
    if (!live.current) {
      return;
    }
    if (!loggedIn) {
      setPhase({ kind: "signing-in" });
      const succeeded = await window.tet.sbx.login();
      if (!live.current) {
        return;
      }
      if (!succeeded) {
        setPhase({ kind: "failed", message: "sbx login failed." });
        return;
      }
    }
    const policyReady = await window.tet.sbx.checkPolicyInitialized();
    if (!live.current) {
      return;
    }
    if (!policyReady) {
      setPhase({ kind: "initializing-policy" });
      const succeeded = await window.tet.sbx.initPolicy();
      if (!live.current) {
        return;
      }
      if (!succeeded) {
        setPhase({ kind: "failed", message: "Could not set up sbx's network policy." });
        return;
      }
    }
    // The dialog's own saved state — read once setup is done, so Save always writes on top of
    // what is actually on disk rather than the blank defaults this component mounted with.
    const config = await window.tet.sbx.getConfig(project.id);
    if (!live.current) {
      return;
    }
    setEnabled(config.enabled);
    setState({
      claude: hydrateAgentState(AGENT_SPECS.claude, config.agents.claude, config.fixedPaths.claude),
      codex: hydrateAgentState(AGENT_SPECS.codex, config.agents.codex, config.fixedPaths.codex)
    });
    setPhase({ kind: "ready" });
  };

  useEffect(() => {
    void setup();
    // Once, on mount — "Check again" runs it by hand.
  }, []);

  /** Writes tet.json and pushes any entered token to `sbx secret set` — see sbx.ts's
   *  saveSbxConfig for why the token itself never reaches tet.json. */
  const save = async (): Promise<void> => {
    setSaving(true);
    const request: SbxSaveRequest = {
      enabled,
      agents: { claude: toSaveAgent(state.claude), codex: toSaveAgent(state.codex) }
    };
    const result = await window.tet.sbx.saveConfig(project.id, request);
    if (!live.current) {
      return;
    }
    setSaving(false);
    if (!result.ok) {
      notify("error", result.error ?? "Could not save the sbx configuration");
      return;
    }
    notify("info", `sbx configuration saved for ${project.name}.`);
    close();
  };

  const busy = phase.kind === "checking" || phase.kind === "signing-in" || phase.kind === "initializing-policy" || saving;

  return (
    <div className="dialog-overlay">
      <div className={phase.kind === "ready" ? "dialog wide enable-sbx-dialog" : "dialog enable-sbx-dialog"}>
        <div className="enable-sbx-bar">
          <span className="enable-sbx-title">Enable sbx — {project.name}</span>
          <button className="icon-button" title="Close" onClick={close}>
            <CloseIcon />
          </button>
          {busy && <ProgressBar />}
        </div>
        <div className="dialog-body">
          {phase.kind === "checking" && <p className="dialog-detail">Checking sbx…</p>}
          {phase.kind === "not-installed" && (
            <p className="dialog-detail">
              Docker Sandboxes (sbx) is not installed. Install it, then check again — a program
              installed somewhere outside its package manager's usual place may only be found once
              tet is restarted.
            </p>
          )}
          {phase.kind === "signing-in" && <p className="dialog-detail">Signing in to sbx…</p>}
          {phase.kind === "initializing-policy" && (
            <p className="dialog-detail">Setting up sbx's network policy…</p>
          )}
          {phase.kind === "failed" && <p className="dialog-detail">{phase.message}</p>}
          {phase.kind === "ready" && (
            <label className="dialog-checkbox">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>
                <strong>Enable sbx sandboxing for this project</strong>
                <p className="dialog-detail">
                  Claude and Codex tabs in {project.name} run in their own isolated Docker sandbox
                  instead of directly on this machine. OpenCode (its server runs on the host) and
                  pi (no sbx kit) stay outside.
                </p>
              </span>
            </label>
          )}
        </div>
        {phase.kind === "ready" && (
          <>
            {/* Outside .dialog-body on purpose — see the CSS: a sibling here, rather than nested
                inside the scrolling body below, is what keeps the tabs from ever scrolling out
                of view, and from opening a horizontal scrollbar on the body that contains them. */}
            <div className="dialog-tabs">
              {TABS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={id === tab ? "dialog-tab active" : "dialog-tab"}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="enable-sbx-fields-scroll">
              <EnableSbxFields
                agent={tab}
                agentState={state[tab]}
                onTokenChange={(value) => patch(tab, { token: value })}
                onAddPort={() => addPort(tab)}
                onRemovePort={(id) => removePort(tab, id)}
                onUpdatePort={(id, change) => updatePort(tab, id, change)}
                onAddFolder={() => addFolder(tab)}
                onRemoveFolder={(id) => removeFolder(tab, id)}
                onUpdateFolder={(id, change) => updateFolder(tab, id, change)}
              />
            </div>
          </>
        )}
        <div className="dialog-buttons">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          {phase.kind === "not-installed" && (
            <>
              <button type="button" className="button secondary" onClick={() => void window.tet.shell.openUrl(SBX_INSTALL_URL)}>
                Get it
              </button>
              <button type="button" className="button" onClick={() => void setup()}>
                Check again
              </button>
            </>
          )}
          {phase.kind === "ready" && (
            <button type="button" className="button" disabled={saving} onClick={() => void save()}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
