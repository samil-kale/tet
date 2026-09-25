import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../shared/errors";
import { EMPTY_SBX_CONFIG, EMPTY_SBX_KNOWLEDGE } from "../../shared/types";
import type { Project, SbxBlocker, SbxKnowledgeSource, SbxProjectConfig, SbxStoredLocal } from "../../shared/types";
import {
  SbxSettingsFields,
  fromConfig,
  policyName,
  needsRestart,
  saveBlocked,
  tabMarks,
  toConfig,
  toLocalSave,
  useSbxProblems,
  type FieldsState
} from "./SbxSettingsFields";
import { SbxAccounts, fromAccounts, toAccountEdits, type AccountRow } from "./SbxAccounts";
import { DialogFrame, useSubmit } from "../ui/DialogFrame";
import { confirm, refusal } from "../ui/Dialog";
import { RestartNote } from "../ui/RestartNote";
import { Checkbox, DialogError } from "../ui/Field";
import { LandmarkIcon } from "../ui/icons";
import { patched } from "../ui/RowSection";
import { useEscape } from "../ui/use-escape";

interface SbxSettingsDialogProps {
  project: Project;
  onClose: () => void;
}

type Phase =
  | { kind: "checking" }
  | { kind: "not-installed" }
  | { kind: "signed-out" }
  | { kind: "initializing-policy" }
  | { kind: "ready"; organization?: string }
  | { kind: "blocked"; organization?: string; blockers: SbxBlocker[] }
  | { kind: "failed"; message: string };

type SbxSettingsTab = "general" | keyof FieldsState;

/** Nothing kept on this machine; also the dialog's initial state. */
const EMPTY_STORED: SbxStoredLocal = { secrets: [], variables: [], knowledge: EMPTY_SBX_KNOWLEDGE };

/** Split along the sections stored in tet.json, and the knowledge kept on this machine. */
const TABS: { id: SbxSettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "knowledge", label: "Knowledge" },
  { id: "ports", label: "Ports" },
  { id: "paths", label: "Paths" },
  { id: "hosts", label: "Hosts" },
  { id: "secrets", label: "Secrets" },
  { id: "variables", label: "Variables" }
];

/**
 * Why a tab cannot be chosen, or `undefined`: nothing but General applies while signed out, and
 * nothing but the switch while sandboxing is off. A tab is disabled rather than dropped, so the
 * dialog keeps its shape and says what is missing.
 */
function tabBlocked(id: SbxSettingsTab, signedIn: boolean, enabled: boolean): string | undefined {
  if (id === "general") {
    return undefined;
  }
  if (!signedIn) {
    return "Sign in to Docker first";
  }
  return enabled ? undefined : "Enable SBX sandboxing for this project first";
}

/**
 * The one dialog for sbx setup and configuration. On mount it checks: installed, then loads the
 * saved config and the access tokens, then signed in — if not, General waits for a sign-in, with a
 * token or the browser, the other tabs disabled — then the machine-wide network policy, set to
 * "balanced" if needed (sbx.ts's initSbxPolicy); each step shows in the `busy` bar. Installs
 * nothing: no command works on all three platforms. A policy not allowing what a sandboxed tab
 * needs (sbx.ts's readSbxBlockers) gets a wall instead of the fields — under an organization's
 * governance only the organization can change that — with the account under it, as another
 * account may be allowed.
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
  const [state, setState] = useState<FieldsState>(() => fromConfig(EMPTY_SBX_CONFIG, EMPTY_STORED));
  /** As opened, for whether the edits wait for a restart (needsRestart). */
  const [loaded, setLoaded] = useState<SbxProjectConfig>(EMPTY_SBX_CONFIG);
  const [stored, setStored] = useState<SbxStoredLocal>(EMPTY_STORED);
  const [sources, setSources] = useState<SbxKnowledgeSource[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  /** Who sbx says is signed in, however it happened. */
  const [signedInUser, setSignedInUser] = useState<string | undefined>(undefined);
  /** A sign-in, sign-out or "Check again" running, and the check after it (`recheck`). */
  const [rechecking, setRechecking] = useState(false);
  /** Why the browser's sign-in or the sign-out failed: no row to mark, so the button row says it. */
  const [accountError, setAccountError] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [tab, setTab] = useState<SbxSettingsTab>(TABS[0].id);
  /** The saved config and tokens are read once: a check after signing in keeps the edits. */
  const loadedOnce = useRef(false);

  /** Installed → saved config → signed in → policy, on mount and "Check again"; again after a
   *  sign-in or sign-out, as the policy and its blockers are the account's. One status call answers
   *  the first three; setting the policy asks again. */
  const setup = async (): Promise<void> => {
    if (!loadedOnce.current) {
      setPhase({ kind: "checking" });
    }
    try {
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
      if (!loadedOnce.current) {
        // Read after the check, so Save writes over what is on disk, not the mount-time defaults.
        const [config, local, knowledgeSources, kept] = await Promise.all([
          window.tet.sbx.getConfig(project.id),
          window.tet.sbx.stored(project.id),
          window.tet.sbx.knowledgeSources(),
          window.tet.sbx.accounts()
        ]);
        setEnabled(isLocked || config.enabled);
        setState(fromConfig(config, local));
        setLoaded(config);
        setStored(local);
        setSources(knowledgeSources);
        setAccounts(fromAccounts(kept));
        loadedOnce.current = true;
      }
      if (!status.loggedIn) {
        setSignedInUser(undefined);
        setPhase({ kind: "signed-out" });
        setTab("general");
        return;
      }
      setSignedInUser(await window.tet.sbx.signedInUser());
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
      setPhase({ kind: "ready", organization: status.organization });
    } catch (error) {
      // The phase is the busy bar: a call that threw must not leave it running.
      setPhase({ kind: "failed", message: `SBX failed: ${errorMessage(error)}` });
      throw error;
    }
  };

  useEffect(() => {
    void setup();
    // Once; "Check again" reruns it. `setup` is remade every render, so naming it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Stores the access tokens, then typed values, saves and applies the rows without a problem,
   *  the marked ones left out (sbx-settings.ts's saveProjectSbx); may remove the sandbox. What sbx
   *  refuses only then goes in the button row: the rows it is about may be on another tab, and
   *  their own marks say which (`tabMarks`). Not signed in, or blocked, only the tokens are saved. */
  const { busy: saving, refused, submit: save, clear } = useSubmit(async () => {
    const tokensRefused = await window.tet.sbx.saveAccounts(toAccountEdits(accounts));
    if (tokensRefused !== undefined) {
      return tokensRefused;
    }
    if (phase.kind !== "ready") {
      return undefined;
    }
    const result = await window.tet.sbx.saveConfig(project.id, { enabled, ...toConfig(state) }, toLocalSave(state));
    return refusal(result, "Could not save the SBX configuration");
  }, close);
  const editState: typeof setState = (update) => {
    setState(update);
    clear();
  };
  const editEnabled = (next: boolean): void => {
    setEnabled(next);
    clear();
  };
  const editAccounts: typeof setAccounts = (update) => {
    setAccounts(update);
    setAccountError(undefined);
    clear();
  };

  /** "Check again", or after a sign-in or sign-out (`run`), whatever its outcome: the policy and
   *  its blockers are the account's, and a sign-in whose token could not be kept went through. */
  const recheck = async (run?: () => Promise<void>): Promise<void> => {
    setRechecking(true);
    setAccountError(undefined);
    try {
      await run?.();
      await setup();
    } finally {
      setRechecking(false);
    }
  };
  /** At once, not on Save: sbx has taken the token, so the row is kept (sbx:sign-in). What sbx
   *  said on refusing marks the row. */
  const signIn = (row: AccountRow): void =>
    void recheck(async () => {
      const result = await window.tet.sbx.signIn(row.user, row.token, row.account);
      const kept = result.account;
      setAccounts((rows) =>
        kept
          ? // A row of the same user already kept is this one now (SbxAccountStore.add).
            patched(
              rows.filter((other) => other.id === row.id || other.account !== kept.id),
              row.id,
              { account: kept.id, user: kept.user, token: "", mark: undefined }
            )
          : patched(rows, row.id, { mark: result.error })
      );
    });
  const browserSignIn = (): void =>
    void recheck(async () => {
      if (!(await window.tet.sbx.login())) {
        setAccountError("SBX login failed.");
      }
    });
  const signOut = async (): Promise<void> => {
    const answer = await confirm({
      title: "Sign out of Docker",
      message: "Sign out of Docker?",
      detail: "Every running sandbox stops, in every project.",
      confirmLabel: "Sign out"
    });
    if (!answer.confirmed) {
      return;
    }
    await recheck(async () => {
      const failed = await window.tet.sbx.logout();
      if (failed !== undefined) {
        setAccountError(`Could not sign out of Docker: ${failed}`);
      }
    });
  };

  const signedIn = phase.kind === "ready" || phase.kind === "blocked";
  const showsAccount = signedIn || phase.kind === "signed-out";
  /** The tabs are up: the fields, or General waiting for a sign-in. */
  const tabbed = phase.kind === "ready" || phase.kind === "signed-out";
  const busy = phase.kind === "checking" || phase.kind === "initializing-policy" || saving || rechecking;
  const blocked = phase.kind === "ready" ? saveBlocked(state) : undefined;
  const organization = phase.kind === "ready" ? phase.organization : undefined;
  // Asked from the moment the rows are loaded, not when their tab is opened; not while sandboxing
  // is off, which applies none of them.
  const problems = useSbxProblems(project.id, state, stored, phase.kind === "ready" && enabled);
  const marks = useMemo(() => tabMarks(state, problems), [state, problems]);
  const tabs = useMemo(
    () =>
      TABS.map((entry) => {
        const disabled = tabBlocked(entry.id, signedIn, enabled);
        // A tab that cannot be chosen says why, not what is inside.
        const mark = disabled || entry.id === "general" ? undefined : marks[entry.id];
        return { ...entry, disabled, mark };
      }),
    [signedIn, enabled, marks]
  );

  const accountSection = (
    <SbxAccounts
      rows={accounts}
      setRows={editAccounts}
      signedIn={signedIn}
      signedInUser={signedInUser}
      busy={busy}
      onSignIn={signIn}
      onBrowserSignIn={browserSignIn}
      onSignOut={() => void signOut()}
    />
  );

  return (
    <DialogFrame
      header={
        tabbed
          ? { tabs, active: tab, onSelect: setTab, onClose: close }
          : { title: `SBX Settings - ${project.name}`, onClose: close }
      }
      className={showsAccount ? "sbx-settings-dialog ready" : "sbx-settings-dialog"}
      busy={busy}
      error={refused ?? accountError}
      message={phase.kind === "ready" && needsRestart(loaded, stored.knowledge, state) && <RestartNote />}
      buttons={
        <>
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          {(phase.kind === "not-installed" || phase.kind === "blocked") && (
            <button type="button" className="button" disabled={busy} onClick={() => void recheck()}>
              Check again
            </button>
          )}
          {showsAccount && (
            // Blocked by class: its tooltip is the reason (.button.disabled).
            <button
              type="button"
              className={blocked === undefined ? "button" : "button disabled"}
              disabled={busy}
              title={blocked}
              onClick={() => blocked === undefined && void save()}
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
      {phase.kind === "initializing-policy" && <p className="dialog-detail">Setting up SBX's network policy…</p>}
      {/* In place of the settings that could not be loaded (DialogError). */}
      {phase.kind === "failed" && <DialogError message={phase.message} />}
      {phase.kind === "blocked" && (
        <>
          <p className="dialog-message">
            {policyName(phase.organization !== undefined)} has to allow these before tet can sandbox {project.name}:
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
          {accountSection}
        </>
      )}
      {tabbed && tab === "general" && (
        <>
          <Checkbox
            checked={enabled}
            disabled={locked || !signedIn}
            onChange={editEnabled}
            label={
              <>
                <strong>Enable SBX sandboxing for this project</strong>
                <p className="dialog-detail">
                  Claude, Codex, OpenCode and Pi tabs run in their own isolated Docker sandbox.
                  {locked && " No agent is installed on this machine, so this is the only way to run one here."}
                </p>
              </>
            }
          />
          <div className={`sbx-governance${organization ? "" : " hidden"}`}>
            <span className="sbx-governance-icon">
              <LandmarkIcon />
            </span>
            <strong>Organization governance is active ({organization})</strong>
          </div>
          {accountSection}
        </>
      )}
      {phase.kind === "ready" && tab !== "general" && (
        <div className="sbx-settings-pane">
          <SbxSettingsFields
            section={tab}
            state={state}
            setState={editState}
            stored={stored}
            sources={sources}
            problems={problems}
          />
        </div>
      )}
    </DialogFrame>
  );
}
