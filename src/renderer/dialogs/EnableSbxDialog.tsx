import { useEffect, useRef, useState } from "react";
import type { Project, SbxAgentId, SbxProjectConfig, SbxSaveRequest } from "../../shared/types";
import { EnableSbxFields, type FieldsState, type FolderRow, type PortRow } from "./EnableSbxFields";
import { DialogFrame } from "../ui/DialogFrame";
import { notify } from "../ui/Notices";
import { useEscape } from "../ui/use-escape";

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

let nextRowId = 0;
/** Local-only id for a port/folder row's React key — never sent anywhere. */
function newRowId(): string {
  nextRowId += 1;
  return `row-${nextRowId}`;
}

/**
 * `sbx:get-config`'s answer (or nothing yet), turned into this dialog's own row shape: each row
 * gets a local id for its React key; the tokens always start blank, since they are never read
 * back. Only the user's own folders — each agent's config directory and tet's own directories
 * are mounted whatever this list says (sbx.ts's computeWorkspaces) and deliberately not shown
 * as rows: nothing about them is the user's to change.
 */
function hydrateState(saved: SbxProjectConfig | undefined): FieldsState {
  return {
    tokens: { claude: "", codex: "" },
    ports: (saved?.ports ?? []).map((port) => ({ id: newRowId(), host: port.host, container: port.container })),
    folders: (saved?.folders ?? []).map((folder) => ({ id: newRowId(), path: folder.path, access: folder.access }))
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
 * the title bar's progress bar (`DialogFrame`'s `busy` — see "One progress indicator per pane"
 * in CLAUDE.md) so the click is never followed by nothing happening. Installing is not a step: the same rule as RequirementsDialog,
 * no command works on all three platforms, so a missing sbx gets Docker's install page and a
 * "Check again".
 *
 * Tokens/ports/folders live here, not in EnableSbxFields: Save (the footer button, once ready)
 * needs to read the current values to build the request it sends to `sbx:save-config` —
 * session-manager.ts's `resolveSbxRun` is what actually acts on what gets saved, the next time
 * a claude/codex tab in this project spawns.
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
  const [state, setState] = useState<FieldsState>(hydrateState(undefined));
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  // So a step that resolves after the dialog closed doesn't set state on an unmounted component.
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const patch = (change: Partial<FieldsState>): void => setState((current) => ({ ...current, ...change }));

  const setToken = (agent: SbxAgentId, value: string): void => patch({ tokens: { ...state.tokens, [agent]: value } });
  const addPort = (): void => patch({ ports: [...state.ports, { id: newRowId(), host: "", container: "" }] });
  const removePort = (id: string): void => patch({ ports: state.ports.filter((port) => port.id !== id) });
  const updatePort = (id: string, change: Partial<PortRow>): void =>
    patch({ ports: state.ports.map((port) => (port.id === id ? { ...port, ...change } : port)) });
  const addFolder = (): void => patch({ folders: [...state.folders, { id: newRowId(), path: "", access: "Read+Write" }] });
  const removeFolder = (id: string): void => patch({ folders: state.folders.filter((folder) => folder.id !== id) });
  const updateFolder = (id: string, change: Partial<FolderRow>): void =>
    patch({ folders: state.folders.map((folder) => (folder.id === id ? { ...folder, ...change } : folder)) });

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
    setState(hydrateState(config));
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
      tokens: state.tokens,
      ports: state.ports.filter((port) => port.host.trim() && port.container.trim()).map(({ host, container }) => ({ host, container })),
      folders: state.folders.filter((folder) => folder.path.trim()).map(({ path, access }) => ({ path, access }))
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
    <DialogFrame
      header={{ title: `Enable sbx — ${project.name}`, onClose: close }}
      className={phase.kind === "ready" ? "wide enable-sbx-dialog" : "enable-sbx-dialog"}
      busy={busy}
      buttons={
        <>
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
        </>
      }
    >
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
        <>
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
          {/* The one part that scrolls — see the CSS: the checkbox above stays put. */}
          <div className="enable-sbx-fields-scroll">
            <EnableSbxFields
              state={state}
              onTokenChange={setToken}
              onAddPort={addPort}
              onRemovePort={removePort}
              onUpdatePort={updatePort}
              onAddFolder={addFolder}
              onRemoveFolder={removeFolder}
              onUpdateFolder={updateFolder}
            />
          </div>
        </>
      )}
    </DialogFrame>
  );
}
