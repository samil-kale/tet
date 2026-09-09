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
 * The one dialog for the whole sbx open path and its configuration — installed or not, signed in
 * or not, network policy set or not, this is where it all shows, not scattered across notices.
 *
 * Runs its own setup once mounted: check sbx is installed, check sign-in, sign in in the
 * background if needed (`sbx login` opens the OAuth page in the browser itself), check the
 * machine-wide network policy, initialize it (to "balanced") if needed — a one-time,
 * all-sandboxes setting, so a background default rather than a per-project choice (see sbx.ts's
 * initSbxPolicy). Each step shows in the title bar's progress bar (`DialogFrame`'s `busy` — see
 * "One progress indicator per pane" in CLAUDE.md) so the click is never followed by nothing
 * happening. Installing is not a step: the same rule as RequirementsDialog, no command works on
 * all three platforms, so a missing sbx gets Docker's install page and a "Check again". An
 * account whose policies an organization manages gets a wall instead of the fields: every mount
 * tet makes is a local filesystem rule, and what a managed policy grants has never been
 * measured (see sbx.ts's checkSbxGoverned) — so tet does not offer sandboxing there at all
 * rather than offering something it cannot verify works.
 *
 * The fields' state lives here, not in SbxSettingsFields: Save (the footer button, once ready)
 * builds the request it sends to `sbx:save-config` from it — session-manager.ts's `resolveSbxRun`
 * is what actually acts on what gets saved, the next time a claude/codex tab in this project
 * spawns. Each sandboxed agent authenticates inside the sandbox (its own `/login`, or for pi a
 * credential from sbx's own store — see SbxProjectConfig) — tet never asks for or stores one.
 *
 * A step that resolves after the dialog closed sets state on an unmounted component, which React
 * ignores — so nothing here tracks whether it is still mounted.
 */
export function SbxSettingsDialog({ project, onClose }: SbxSettingsDialogProps) {
  // One way out, whichever of × / Escape / Cancel triggers it: `cancelSbxSetup` is a no-op when
  // nothing is running, so this is safe to call every time, not just from the Cancel button.
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
    // The dialog's own saved state — read once setup is done, so Save always writes on top of
    // what is actually on disk rather than the blank defaults this component mounted with.
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
        // The one part that scrolls — see the CSS: the checkbox above stays put.
        <div className="sbx-settings-fields-scroll">
          <SbxSettingsFields state={state} setState={setState} />
        </div>
      )}
    </DialogFrame>
  );
}
