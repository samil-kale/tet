import { useEffect, useMemo, useState } from "react";
import { EMPTY_SBX_CONFIG } from "../../shared/types";
import type { Project, SbxBlocker } from "../../shared/types";
import { SbxSettingsFields, canSave, fromConfig, toConfig, type FieldsState } from "./SbxSettingsFields";
import { DialogFrame } from "../ui/DialogFrame";
import { notify } from "../ui/Notices";
import { useEscape } from "../ui/use-escape";

interface SbxSettingsDialogProps {
  project: Project;
  onClose: () => void;
}

type Phase =
  | { kind: "checking" }
  | { kind: "not-installed" }
  | { kind: "signing-in" }
  | { kind: "initializing-policy" }
  | { kind: "ready"; organization?: string }
  | { kind: "blocked"; organization?: string; blockers: SbxBlocker[] }
  | { kind: "failed"; message: string };

type SbxSettingsTab = "general" | keyof FieldsState;

/** Split along the sections stored in tet.json. */
const TABS: { id: SbxSettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "knowledge", label: "Knowledge" },
  { id: "ports", label: "Ports" },
  { id: "paths", label: "Paths" },
  { id: "hosts", label: "Hosts" }
];

/**
 * Why a tab cannot be chosen, or `undefined`. Nothing but the switch applies while sandboxing is
 * off; knowledge from this machine is meaningless where no agent is installed; under an
 * organization's governance a local host rule is inactive (sbx.ts's readSandboxHosts). A tab is
 * disabled rather than dropped, so the dialog keeps its shape and says what is missing.
 */
function tabBlocked(
  id: SbxSettingsTab,
  { enabled, locked, organization }: { enabled: boolean; locked: boolean; organization?: string }
): string | undefined {
  if (id === "general") {
    return undefined;
  }
  if (!enabled) {
    return "Enable SBX sandboxing for this project first";
  }
  if (id === "knowledge" && locked) {
    return "No agent is installed on this machine to bring anything from";
  }
  if (id === "hosts" && organization) {
    return `Deactivated by governance: only ${organization} can allow hosts for sandboxes`;
  }
  return undefined;
}

/**
 * The one dialog for sbx setup and configuration. On mount it checks: installed, signed in
 * (signing in if needed), machine-wide network policy set to "balanced" if needed (sbx.ts's
 * initSbxPolicy), then loads the saved config; each step shows in the `busy` bar. Installs
 * nothing: no command works on all three platforms. A policy not allowing what a sandboxed tab
 * needs (sbx.ts's readSbxBlockers) gets a wall instead of the fields — under an organization's
 * governance only the organization can change that.
 *
 * The fields' state lives here, since Save builds `sbx:save-config` from it. Each sandboxed agent
 * authenticates inside the sandbox.
 */
export function SbxSettingsDialog({ project, onClose }: SbxSettingsDialogProps) {
  // × / Escape / Cancel all go here; `cancelSbxSetup` is a no-op when nothing runs.
  const close = (): void => {
    window.tet.sbx.cancelSetup();
    onClose();
  };
  useEscape(close);
  const [enabled, setEnabled] = useState(false);
  /** No agent on this machine, so sandboxing cannot be switched off. Derived on every open, not
   *  stored. */
  const [locked, setLocked] = useState(false);
  const [state, setState] = useState<FieldsState>(() => fromConfig(EMPTY_SBX_CONFIG));
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [tab, setTab] = useState<SbxSettingsTab>(TABS[0].id);

  /** Installed → signed in → policy → saved config, on mount and "Check again". One status call
   *  answers the first three; signing in or setting the policy asks again. */
  const setup = async (): Promise<void> => {
    setPhase({ kind: "checking" });
    // In parallel with the status: both re-read PATH, and joining a running call is free
    // (augmentAgentPath). This run reads the local value; the state lands next render.
    const [initialStatus, anyAgent] = await Promise.all([
      window.tet.sbx.status(project.id),
      window.tet.startup.anyAgentInstalled()
    ]);
    const isLocked = !anyAgent;
    setLocked(isLocked);
    let status = initialStatus;
    if (!status.installed) {
      setPhase({ kind: "not-installed" });
      return;
    }
    if (status.failure) {
      setPhase({ kind: "failed", message: `SBX failed: ${status.failure}` });
      return;
    }
    if (!status.loggedIn) {
      setPhase({ kind: "signing-in" });
      if (!(await window.tet.sbx.login())) {
        setPhase({ kind: "failed", message: "SBX login failed." });
        return;
      }
      status = await window.tet.sbx.status(project.id);
    }
    if (!status.policyInitialized) {
      setPhase({ kind: "initializing-policy" });
      if (!(await window.tet.sbx.initPolicy())) {
        setPhase({ kind: "failed", message: "Could not set up SBX's network policy." });
        return;
      }
      status = await window.tet.sbx.status(project.id);
    }
    if (status.blockers.length > 0) {
      setPhase({ kind: "blocked", organization: status.organization, blockers: status.blockers });
      return;
    }
    // Read after setup, so Save writes over what is on disk, not the mount-time defaults.
    const config = await window.tet.sbx.getConfig(project.id);
    setEnabled(isLocked || config.enabled);
    setState(fromConfig(config));
    setPhase({ kind: "ready", organization: status.organization });
  };

  useEffect(() => {
    void setup();
    // Once; "Check again" reruns it.
  }, []);

  /** Writes tet.json; may remove the sandbox (sbx.ts's saveSbxConfig). */
  const save = async (): Promise<void> => {
    setSaving(true);
    const result = await window.tet.sbx.saveConfig(project.id, { enabled, ...toConfig(state) });
    setSaving(false);
    if (!result.ok) {
      notify("error", result.error ?? "Could not save the SBX configuration");
      return;
    }
    notify("info", `SBX configuration saved for ${project.name}.`);
    close();
  };

  const busy = phase.kind === "checking" || phase.kind === "signing-in" || phase.kind === "initializing-policy" || saving;
  const organization = phase.kind === "ready" ? phase.organization : undefined;
  const tabs = useMemo(
    () => TABS.map((entry) => ({ ...entry, disabled: tabBlocked(entry.id, { enabled, locked, organization }) })),
    [enabled, locked, organization]
  );

  return (
    <DialogFrame
      header={
        phase.kind === "ready"
          ? { tabs, active: tab, onSelect: setTab, onClose: close }
          : { title: `SBX Settings - ${project.name}`, onClose: close }
      }
      className={phase.kind === "ready" ? "wide sbx-settings-dialog" : "sbx-settings-dialog"}
      busy={busy}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          {(phase.kind === "not-installed" || phase.kind === "blocked") && (
            <button type="button" className="button" onClick={() => void setup()}>
              Check again
            </button>
          )}
          {phase.kind === "ready" && (
            <button
              type="button"
              className="button"
              disabled={saving || !canSave(state)}
              title={canSave(state) ? undefined : "A port on the Ports tab is not a whole number from 1 to 65535"}
              onClick={() => void save()}
            >
              Save
            </button>
          )}
        </>
      }
    >
      {phase.kind === "checking" && <p className="dialog-detail">Checking SBX…</p>}
      {phase.kind === "not-installed" && (
        <p className="dialog-detail">Docker Sandboxes (SBX) is not installed. Install it, then check again.</p>
      )}
      {phase.kind === "signing-in" && <p className="dialog-detail">Signing in to SBX…</p>}
      {phase.kind === "initializing-policy" && <p className="dialog-detail">Setting up SBX's network policy…</p>}
      {phase.kind === "failed" && <p className="dialog-detail">{phase.message}</p>}
      {phase.kind === "blocked" && (
        <>
          <p className="dialog-message">
            {phase.organization ? "Your organization's SBX policy" : "SBX's policy"} has to allow these
            before tet can sandbox {project.name}:
          </p>
          <div className="requirement-list">
            {phase.blockers.map((blocker) => (
              <div key={blocker.what} className="requirement-item">
                <span className="requirement-name">{blocker.what}</span>
                <span className="requirement-command">{blocker.allow}</span>
              </div>
            ))}
          </div>
          {phase.organization && (
            <p className="dialog-detail">Only your organization can add these rules. Check again once it has.</p>
          )}
        </>
      )}
      {phase.kind === "ready" && tab === "general" && (
        <label className="dialog-checkbox">
          <input
            type="checkbox"
            checked={enabled}
            disabled={locked}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            <strong>Enable SBX sandboxing for this project</strong>
            <p className="dialog-detail">
              Claude, Codex, OpenCode and Pi tabs in {project.name} run in their own isolated Docker
              sandbox instead of directly on this machine.
              {locked && " No agent is installed on this machine, so this is the only way to run one here."}
            </p>
          </span>
        </label>
      )}
      {phase.kind === "ready" && tab === "general" && (
        <div className="sbx-governance">
          <strong>Organization governance</strong>
          <p className="dialog-detail">
            {phase.organization ? (
              <>
                Active: SBX's policy is managed by <strong>{phase.organization}</strong>, so only it can allow hosts
                for sandboxes.
              </>
            ) : (
              "Not active: SBX's policy is managed on this machine."
            )}
          </p>
        </div>
      )}
      {phase.kind === "ready" && tab !== "general" && (
        <div className="sbx-settings-pane">
          <SbxSettingsFields section={tab} state={state} setState={setState} governed={organization !== undefined} />
        </div>
      )}
    </DialogFrame>
  );
}
