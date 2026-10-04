import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { envRowRefusal } from "../../shared/env-rules";
import { errorMessage } from "../../shared/errors";
import { KEYBINDING_PRESETS } from "../../shared/keybinding-presets";
import { DEFAULT_PROMPTS, effectivePrompt } from "../../shared/prompts";
import { resolveTheme, schemeKind, themeKey, THEMES, type ThemeKind } from "../../shared/themes";
import { COLOR_SCHEMES, DEFAULT_KEYBINDING_PRESET_ID, PROMPT_IDS, withSettings } from "../../shared/types/settings";
import type { Suggester } from "../../shared/types/agents";
import type { AppInfo } from "../../shared/types/app";
import type { EnvEdit } from "../../shared/types/environment";
import type { ExplorerSortOrder } from "../../shared/types/files";
import type { AppSettings, ColorScheme, GitSettings, NotificationSettings, PromptId, SettingsEdits } from "../../shared/types/settings";
import { confirm } from "../ui/Dialog";
import { DialogFrame, useSubmit } from "../ui/DialogFrame";
import { Dropdown } from "../ui/Dropdown";
import { Checkbox, DialogError, Field, FieldColumn, FieldGroup, FieldRow } from "../ui/Field";
import { RadioGroup } from "../ui/RadioGroup";
import { RestartNote } from "../ui/RestartNote";
import { useBusy } from "../ui/use-busy";
import { PLATFORM } from "../platform";
import { atLeastOne, EditRow, firstMark, OverridesMachine, patched, RowInput, RowSection, SecretInput, typedRows, withId, type Row } from "../ui/RowSection";
import { SHORTCUTS, shortcutLabel } from "../shortcuts";
import { SuggesterPicker } from "./SuggesterPicker";

interface SettingsDialogProps {
  onClose: () => void;
}

type SettingsTab = "appearance" | "notifications" | "files" | "git" | "prompts" | "environment" | "info";

/** The dialog opens on the first. */
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "files", label: "Files" },
  { id: "git", label: "Git" },
  { id: "prompts", label: "Prompts" },
  { id: "environment", label: "Environment" },
  { id: "info", label: "Info" }
];

type EnvRow = Row<{ name: string; from?: string; value: string; overridesMachine: boolean }>;

/** A row as "+ Add" makes it, and as one stands in where there are none (`atLeastOne`). */
const BLANK_ENV_ROW = { name: "", value: "", overridesMachine: false };

/** A row as Save sends it; undefined for one added and left empty, which is no row. A stored one
 *  left empty keeps its value. */
function envEdit(row: EnvRow): EnvEdit | undefined {
  if (row.from === undefined && row.name.trim() === "" && row.value === "") {
    return undefined;
  }
  return { name: row.name.trim(), from: row.from, value: row.value === "" ? undefined : row.value };
}

/** Whether the rows differ from the variables `loaded` — a value typed, a name changed, a row added
 *  or removed — which a running tab takes up only once it restarts (pty.ts's buildEnv). */
function envChanged(rows: EnvRow[], loaded: readonly string[]): boolean {
  const edits = rows.map(envEdit).filter((edit): edit is EnvEdit => edit !== undefined);
  return (
    edits.some((edit) => edit.value !== undefined || edit.name !== edit.from) ||
    loaded.some((name) => !edits.some((edit) => edit.from === name))
  );
}

/** Each row's mark by id — the rule the store refuses by (env-rules.ts), so Save never meets it. */
function envMarks(rows: EnvRow[]): Map<string, string> {
  const marks = new Map<string, string>();
  const before: EnvEdit[] = [];
  for (const row of rows) {
    const edit = envEdit(row);
    if (edit) {
      const refusal = envRowRefusal(edit, before, PLATFORM.envNamesIgnoreCase);
      if (refusal) {
        marks.set(row.id, refusal);
      }
      before.push(edit);
    }
  }
  return marks;
}

const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark"
};

const PROMPT_LABELS: Record<PromptId, string> = {
  commitMessage: "Commit message",
  handover: "Session handover"
};

const NOTIFICATION_SWITCHES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "finished", label: "Finished - the turn ended" },
  { key: "waiting", label: "Waiting for an answer - a permission prompt or a question" },
  // Not live: its hook is in the agent's host setup only when on, redone on a change (HostSetups),
  // so it reaches tabs started afterwards (AgentPaths.idleReminder).
  { key: "idleReminder", label: "Still waiting - no new prompt for a while (Claude Code only)" }
];

const GIT_SWITCHES: { key: keyof GitSettings; label: string }[] = [
  { key: "checkNewChanges", label: "Check new changes for the next commit" },
  { key: "pushOnCommit", label: "Also push when committing" },
  { key: "deleteBranchOnRemote", label: "Also delete branch on the remote" },
  { key: "deleteTagOnRemote", label: "Also delete tag on the remote" },
  { key: "deleteWorktreeOnRemote", label: "Also delete worktree on the remote" }
];

/**
 * `foldersNestsFiles` is left out: without file nesting it sorts like `default`. A hand-written
 * settings.json can still hold it.
 */
const SORT_ORDERS: { id: ExplorerSortOrder; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "mixed", label: "Mixed" },
  { id: "filesFirst", label: "Files First" },
  { id: "type", label: "Type" },
  { id: "modified", label: "Modified" }
];

const INFO_ROWS: { key: keyof AppInfo; label: string }[] = [
  { key: "version", label: "TET" },
  { key: "electron", label: "Electron" },
  { key: "chromium", label: "Chromium" },
  { key: "node", label: "Node" },
  { key: "os", label: "Platform" }
];

/**
 * Everything TET keeps about itself, not a repository. Not in Dialog.tsx: it asks nothing, edits
 * its own copy and writes on Save; Cancel and Escape drop the edits. A setting reaches an agent
 * through `AgentPaths` at `AgentHost.prepare`, once per agent (HostSetups), as does the color theme. Deliberately
 * not in here: the tab marks.
 */
export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(TABS[0].id);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [promptId, setPromptId] = useState<PromptId>(PROMPT_IDS[0]);
  /** What Save writes: the keys the dialog touched, and no others. tet-ctl may set another one
   *  while the dialog stands open, and Save must not take it back (settings.ts's patch). */
  const edits = useRef<SettingsEdits>({});
  /** The Environment tab's rows: `from` the stored variable a row shows, `value` only what was
   *  typed since opening — a stored one never reaches the renderer. */
  const [variables, setVariables] = useState<EnvRow[]>([]);
  /** Save writes the tab only once it was touched. */
  const variablesEdited = useRef(false);
  /** The stored variables' names as opened, for `envChanged`. */
  const [loadedVariables, setLoadedVariables] = useState<readonly string[]>([]);
  /** The Prompts tab's model listing underway, on the header's bar (`SuggesterPicker`'s `hold`). */
  const [listingModels, setListingModels] = useState(false);

  /** The settings as opened, on the header's bar; what could not be read stands in their place
   *  (`DialogError`), as the SBX Settings's does. */
  const { busy: loading, run: load } = useBusy(true);
  const [loadFailed, setLoadFailed] = useState<string | undefined>(undefined);
  useEffect(() => {
    void load(() =>
      Promise.all([
        window.tet.settings.get().then(setSettings),
        // Cannot change while the process runs.
        window.tet.app.info().then(setInfo),
        window.tet.env.list().then((list) => {
          setVariables(atLeastOne(list.map((variable) => withId({ ...variable, from: variable.name, value: "" })), BLANK_ENV_ROW));
          setLoadedVariables(list.map((variable) => variable.name));
        })
      ])
    ).catch((error: unknown) => setLoadFailed(errorMessage(error)));
  }, [load]);

  /** The Environment tab if touched, then the settings.json write — last, since it applies at once
   *  (the theme among it) and Cancel could not take it back after a later write refused. */
  const { busy: saving, refused, submit: save, changing } = useSubmit(
    async () => {
      if (variablesEdited.current) {
        const rows = variables.map(envEdit).filter((edit): edit is EnvEdit => edit !== undefined);
        const refusal = await window.tet.env.save(rows);
        if (refusal) {
          return refusal;
        }
        variablesEdited.current = false;
      }
      if (Object.keys(edits.current).length > 0) {
        await window.tet.settings.patch(edits.current);
      }
      return undefined;
    },
    () => {
      onClose();
      // Asked after closing: a kind switch is saved either way, Cancel only waits for the next start.
      if (chosenKind !== shownKind) {
        void confirm({
          title: "Restart TET",
          message: `Restart TET now to switch to the ${chosenKind} theme?`,
          detail: "This ends every tab in every project. Otherwise it applies at the next start.",
          confirmLabel: "Restart",
          // Never settles: the question stays up, its bar running, until the restart ends the window.
          submit: () => {
            window.tet.app.restart();
            return new Promise(() => {});
          }
        });
      }
    }
  );

  /** Edits the shown copy and records the change for Save. */
  const edit = changing((change: SettingsEdits): void => {
    edits.current = withSettings(edits.current, change);
    setSettings((current) => (current ? withSettings(current, change) : current));
  });

  const flipNotification = (key: keyof NotificationSettings, value: boolean): void => edit({ notifications: { [key]: value } });

  const flipGit = (key: keyof GitSettings, value: boolean): void => edit({ git: { [key]: value } });

  const applyPreset = (id: string): void => edit({ files: { editorKeybindingPreset: id } });

  const applyColorScheme = (scheme: ColorScheme): void => edit({ appearance: { colorScheme: scheme } });

  const applyTheme = (kind: ThemeKind, id: string): void => edit({ appearance: { [themeKey(kind)]: id } });

  // The kind shown now, and the one Save asks for — "system" resolved by the OS now (Electron's
  // prefers-color-scheme follows nativeTheme, which theme.ts's currentTheme reads).
  const shownKind = resolveTheme(document.documentElement.dataset.theme).kind;
  const scheme = settings?.appearance.colorScheme ?? "system";
  const chosenKind = schemeKind(scheme, window.matchMedia("(prefers-color-scheme: dark)").matches);

  /** TET's own text is stored as "", as in settings.ts; the reset button reads that. */
  const applyPrompt = (id: PromptId, text: string): void =>
    edit({ prompts: { texts: { [id]: text === DEFAULT_PROMPTS[id] ? "" : text } } });

  /** A pick not offered on this machine is shown replaced, not saved: another machine may offer it. */
  const replaceSuggester = useCallback(
    (suggester: Suggester): void => setSettings((current) => (current ? { ...current, prompts: { ...current.prompts, commitSuggester: suggester } } : current)),
    []
  );

  const editVariables = changing((change: (rows: typeof variables) => typeof variables): void => {
    variablesEdited.current = true;
    setVariables(change);
  });
  const envRows = typedRows("variable", BLANK_ENV_ROW, editVariables);

  const envRowMarks = useMemo(() => envMarks(variables), [variables]);
  const blocked = firstMark(envRowMarks.values());
  const tabs = useMemo(() => TABS.map((entry) => (entry.id === "environment" ? { ...entry, mark: blocked } : entry)), [blocked]);

  // Nothing of it shown while it could not be read.
  const shown = loadFailed === undefined ? tab : undefined;
  // Live within one kind only: an agent gets light or dark when its tab starts (main.ts's
  // applyTheme).
  const kindSwitched = settings !== null && chosenKind !== shownKind;
  const envRestart = envChanged(variables, loadedVariables);

  return (
    <DialogFrame
      header={{ tabs, active: tab, onSelect: setTab }}
      busy={saving || loading || listingModels}
      // Loading and listing the models only read: Cancel stays open meanwhile.
      locked={saving}
      error={refused}
      message={
        (kindSwitched || envRestart) && (
          <>
            {kindSwitched && <span className="restart-note">Switching between light and dark applies after TET is restarted.</span>}
            {kindSwitched && envRestart && " "}
            {envRestart && <RestartNote />}
          </>
        )
      }
      className="settings-dialog"
      onCancel={onClose}
      primary={{ label: "Save", blocked, disabled: loading || loadFailed !== undefined, run: () => void save() }}
    >
      {loadFailed !== undefined && <DialogError message={loadFailed} />}
      {shown === "appearance" && (
        <>
          <FieldGroup label="Color scheme">
            <RadioGroup
              value={scheme}
              onChange={applyColorScheme}
              options={COLOR_SCHEMES.map((option) => ({ value: option, label: COLOR_SCHEME_LABELS[option] }))}
            />
          </FieldGroup>
          <Field label={chosenKind === "dark" ? "Dark theme" : "Light theme"}>
            <Dropdown
              value={resolveTheme(settings?.appearance[themeKey(chosenKind)], chosenKind).id}
              onChange={(id) => applyTheme(chosenKind, id)}
              options={THEMES.filter((theme) => theme.kind === chosenKind).map((theme) => ({
                value: theme.id,
                label: theme.label
              }))}
            />
          </Field>
        </>
      )}
      {shown === "notifications" && (
        <>
          <FieldGroup label="Desktop notifications for agent activity">
            {settings &&
              NOTIFICATION_SWITCHES.map(({ key, label }) => (
                <Checkbox
                  key={key}
                  label={label}
                  checked={settings.notifications[key]}
                  onChange={(next) => flipNotification(key, next)}
                />
              ))}
          </FieldGroup>
          {/* No restart caveat: hooks report every turn, and the notification reads the settings as they
              stand on arrival (session-manager's `notification`). */}
        </>
      )}
      {shown === "files" && (
        <>
          <FieldGroup label="Explorer settings">
            {settings && (
              <>
                <Checkbox
                  label="Hide what git ignores too"
                  checked={settings.files.excludeGitIgnore}
                  onChange={(next) => edit({ files: { excludeGitIgnore: next } })}
                />
                <Checkbox
                  label="Compact single-child folders"
                  checked={settings.files.compactFolders}
                  onChange={(next) => edit({ files: { compactFolders: next } })}
                />
                <Field label="Sort order">
                  <Dropdown
                    value={settings.files.sortOrder}
                    onChange={(order) => edit({ files: { sortOrder: order } })}
                    options={SORT_ORDERS.map((order) => ({ value: order.id, label: order.label }))}
                  />
                </Field>
              </>
            )}
          </FieldGroup>
          <Field label="Editor keybindings">
            <Dropdown
              value={settings?.files.editorKeybindingPreset ?? DEFAULT_KEYBINDING_PRESET_ID}
              onChange={applyPreset}
              options={KEYBINDING_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
            />
          </Field>
        </>
      )}
      {shown === "git" && (
        <FieldGroup label="Checked to begin with">
          {settings &&
            GIT_SWITCHES.map(({ key, label }) => (
              <Checkbox key={key} label={label} checked={settings.git[key]} onChange={(next) => flipGit(key, next)} />
            ))}
        </FieldGroup>
      )}
      {shown === "prompts" && settings && (
        <>
          <FieldGroup label="Prompt">
            <FieldRow>
              <Dropdown
                value={promptId}
                onChange={setPromptId}
                options={PROMPT_IDS.map((id) => ({ value: id, label: PROMPT_LABELS[id] }))}
              />
              <button
                type="button"
                className="button secondary"
                disabled={settings.prompts.texts[promptId] === ""}
                onClick={() => applyPrompt(promptId, "")}
              >
                Reset to default
              </button>
            </FieldRow>
          </FieldGroup>
          {/* Only for a prompt TET asks in the background; a handover's goes to the tab taking over. */}
          {promptId === "commitMessage" && (
            <FieldGroup label="Suggested by">
              <SuggesterPicker
                value={settings.prompts.commitSuggester}
                onChange={(suggester) => edit({ prompts: { commitSuggester: suggester } })}
                onReplace={replaceSuggester}
                hold={setListingModels}
              />
            </FieldGroup>
          )}
          {/* Always the text the agent gets, never a placeholder. Read when the suggestion is
              asked for, so it applies on Save. */}
          <textarea
            className="settings-prompt"
            spellCheck={false}
            value={effectivePrompt(settings.prompts.texts, promptId)}
            onChange={(event) => applyPrompt(promptId, event.target.value)}
          />
        </>
      )}
      {shown === "environment" && (
        <FieldColumn fill className="settings-environment">
          <RowSection
            label="Environment variables"
            rows={variables}
            renderRow={(row) => (
              <EditRow key={row.id} mark={envRowMarks.get(row.id)} {...envRows.remove(row.id)}>
                <RowInput
                  placeholder="GITLAB_TOKEN"
                  title="The name every tab sees"
                  value={row.name}
                  onChange={(name) => editVariables((rows) => patched(rows, row.id, { name }))}
                />
                {row.overridesMachine && <OverridesMachine name={row.name} />}
                <SecretInput
                  stored={Boolean(row.from)}
                  value={row.value}
                  onChange={(value) => editVariables((rows) => patched(rows, row.id, { value }))}
                />
              </EditRow>
            )}
            add={envRows.add}
          />
        </FieldColumn>
      )}
      {shown === "info" && info && (
        <div className="settings-info-columns">
          <FieldColumn>
            <p className="dialog-detail">Versions</p>
            {INFO_ROWS.map(({ key, label }) => (
              <div key={key} className="settings-info-row">
                <span>{label}</span>
                <span>{info[key]}</span>
              </div>
            ))}
          </FieldColumn>
          <FieldColumn fill>
            <p className="dialog-detail">Shortcuts</p>
            {SHORTCUTS.map(({ id, description }) => (
              <div key={id} className="settings-shortcut-row">
                <span>{shortcutLabel(id)}</span>
                <span>{description}</span>
              </div>
            ))}
          </FieldColumn>
        </div>
      )}
    </DialogFrame>
  );
}
