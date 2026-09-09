import { useEffect, useState } from "react";
import { EMPTY_SBX_CONFIG } from "../../shared/types";
import type { Project } from "../../shared/types";
import { SbxSettingsFields, fromConfig, toConfig, type FieldsState } from "./SbxSettingsFields";
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
  | { kind: "ready" }
  | { kind: "governed" }
  | { kind: "failed"; message: string };

/**
 * The one dialog for the whole sbx open path and its configuration. Runs its own setup once
 * mounted: sbx installed, signed in (signing in in the background if needed), machine-wide
 * network policy initialized to "balanced" if needed (see sbx.ts's initSbxPolicy), then the
 * project's saved config. Each step shows in `DialogFrame`'s `busy` bar. Installs nothing: no
 * command works on all three platforms. An account whose policies an organization manages gets
 * a wall instead of the fields, what a managed policy grants never having been measured.
 *
 * The fields' state lives here, not in SbxSettingsFields: Save builds the `sbx:save-config`
 * request from it. Each sandboxed agent authenticates inside the sandbox.
 */
export function SbxSettingsDialog({ project, onClose }: SbxSettingsDialogProps) {
  // One way out, whichever of × / Escape / Cancel triggers it: `cancelSbxSetup` is a no-op when
  // nothing is running.
  const close = (): void => {
    window.tet.sbx.cancelSetup();
    onClose();
  };
  useEscape(close);
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<FieldsState>(() => fromConfig(EMPTY_SBX_CONFIG));
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  /** Installed → signed in → policy → saved config. Run on mount and by "Check again". */
  const setup = async (): Promise<void> => {
    setPhase({ kind: "checking" });
    if (!(await window.tet.sbx.checkInstalled())) {
      setPhase({ kind: "not-installed" });
      return;
    }
    if (!(await window.tet.sbx.checkLoggedIn())) {
      setPhase({ kind: "signing-in" });
      if (!(await window.tet.sbx.login())) {
        setPhase({ kind: "failed", message: "SBX login failed." });
        return;
      }
    }
    if (!(await window.tet.sbx.checkPolicyInitialized())) {
      setPhase({ kind: "initializing-policy" });
      if (!(await window.tet.sbx.initPolicy())) {
        setPhase({ kind: "failed", message: "Could not set up SBX's network policy." });
        return;
      }
    }
    if (await window.tet.sbx.checkGoverned()) {
      setPhase({ kind: "governed" });
      return;
    }
    // Read once setup is done, so Save writes on top of what is on disk rather than the blank
    // defaults this component mounted with.
    const config = await window.tet.sbx.getConfig(project.id);
    setEnabled(config.enabled);
    setState(fromConfig(config));
    setPhase({ kind: "ready" });
  };

  useEffect(() => {
    void setup();
    // Once, on mount — "Check again" runs it by hand.
  }, []);

  /** Writes tet.json — see sbx.ts's saveSbxConfig for the sandbox removal Save can trigger. */
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

  return (
    <DialogFrame
      header={{ title: `SBX Settings - ${project.name}`, onClose: close }}
      className={phase.kind === "ready" ? "wide sbx-settings-dialog" : "sbx-settings-dialog"}
      busy={busy}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          {phase.kind === "not-installed" && (
            <button type="button" className="button" onClick={() => void setup()}>
              Check again
            </button>
          )}
          {phase.kind === "ready" && (
            <button type="button" className="button" disabled={saving} onClick={() => void save()}>
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
      {phase.kind === "governed" && (
        <p className="dialog-detail">
          Your organization manages SBX's policies. SBX sandboxing in tet does not work under a
          managed policy yet, so it is not offered here.
        </p>
      )}
      {phase.kind === "ready" && (
        <label className="dialog-checkbox">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>
            <strong>Enable SBX sandboxing for this project</strong>
            <p className="dialog-detail">
              Claude, Codex, OpenCode and Pi tabs in {project.name} run in their own isolated Docker
              sandbox instead of directly on this machine.
            </p>
          </span>
        </label>
      )}
      {phase.kind === "ready" && (
        // The one part that scrolls; the checkbox above stays put.
        <div className="sbx-settings-fields-scroll">
          <SbxSettingsFields state={state} setState={setState} />
        </div>
      )}
    </DialogFrame>
  );
}
