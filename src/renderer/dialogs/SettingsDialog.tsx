import { useEffect, useMemo, useRef, useState } from "react";
import { envRowRefusal } from "../../shared/env-rules";
import { errorMessage } from "../../shared/errors";
import { DEFAULT_PROMPTS, effectivePrompt } from "../../shared/prompts";
import { resolveTheme, schemeKind, themeKey, THEMES, type ThemeKind } from "../../shared/themes";
import { COLOR_SCHEMES, DEFAULT_KEYBINDING_PRESET_ID, PROMPT_IDS, withSettings } from "../../shared/types";
import type {
  AppInfo,
  EnvEdit,
  AppSettings,
  ColorScheme,
  ExplorerSettings,
  ExplorerSortOrder,
  NotificationSettings,
  Project,
  PromptId,
  SettingsEdits
} from "../../shared/types";
import { confirm, refusal } from "../ui/Dialog";
import { DialogFrame, useSubmit } from "../ui/DialogFrame";
import { Dropdown } from "../ui/Dropdown";
import { Checkbox, Field, FieldGroup } from "../ui/Field";
import { KEYBINDING_PRESETS } from "../diff/keybinding-presets";
import { RadioGroup } from "../ui/RadioGroup";
import { RestartNote } from "../ui/RestartNote";
import { ActionLink } from "../ui/ActionLink";
import { isWindows } from "../platform";
import { atLeastOne, EditRow, OverridesMachine, patched, RowSection, SecretInput, withId, without, type Row } from "../ui/RowSection";
import { SHORTCUTS, shortcutLabel } from "../shortcuts";
import { useEscape } from "../ui/use-escape";

interface SettingsDialogProps {
  /** Whose tet.json the Files tab's Explorer settings edit; null hides them. */
  activeProject: Project | null;
  onClose: () => void;
}

type SettingsTab = "appearance" | "notifications" | "files" | "prompts" | "environment" | "info";

/** The dialog opens on the first. */
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "files", label: "Files" },
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
      const refusal = envRowRefusal(edit, before, isWindows());
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
  commitMessage: "Commit message"
};

const SWITCHES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "finished", label: "Finished — the turn ended and nothing it started is still running" },
  { key: "needsYou", label: "Action needed — waiting on a permission prompt or a question" },
  // Not live: its hook is registered per tab only when on, since only a toast comes of it
  // (AgentPaths.idleReminder).
  { key: "idleReminder", label: "Still waiting — no new prompt for a while (Claude Code only, from the next tab on)" }
];

/**
 * `foldersNestsFiles` is left out: without file nesting it sorts like `default`. A hand-written
 * tet.json can still hold it.
 */
const SORT_ORDERS: { id: ExplorerSortOrder; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "mixed", label: "Mixed" },
  { id: "filesFirst", label: "Files First" },
  { id: "type", label: "Type" },
  { id: "modified", label: "Modified" }
];

/** The Files tab's tet.json keys, one write each, in Save's order. */
const EXPLORER_KEYS: (keyof ExplorerSettings)[] = ["excludeGitIgnore", "compactFolders", "sortOrder"];

const INFO_ROWS: { key: keyof AppInfo; label: string }[] = [
  { key: "version", label: "TET" },
  { key: "electron", label: "Electron" },
  { key: "chromium", label: "Chromium" },
  { key: "node", label: "Node" },
  { key: "os", label: "Platform" }
];

/**
 * Everything tet keeps about itself, not a repository. Not in Dialog.tsx: it asks nothing, edits
 * its own copy and writes on Save; Cancel and Escape drop the edits. A setting reaches an agent
 * through `AgentPaths` at `prepareSpawn`, once per agent (HostSetups), as does the color theme. Deliberately
 * not in here: the session marks.
 */
export function SettingsDialog({ activeProject, onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(TABS[0].id);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [explorerSettings, setExplorerSettings] = useState<ExplorerSettings | null>(null);
  const [promptId, setPromptId] = useState<PromptId>(PROMPT_IDS[0]);
  /** What Save writes: the keys the dialog touched, and no others. tet-ctl may set another one
   *  while the dialog stands open, and Save must not take it back (settings.ts's patch). */
  const edits = useRef<SettingsEdits>({});
  /** tet.json as opened: Save writes only the keys that differ. */
  const loadedExplorer = useRef<ExplorerSettings | null>(null);
  /** The Environment tab's rows: `from` the stored variable a row shows, `value` only what was
   *  typed since opening — a stored one never reaches the renderer. */
  const [variables, setVariables] = useState<EnvRow[]>([]);
  /** Save writes the tab only once it was touched. */
  const variablesEdited = useRef(false);
  /** The stored variables' names as opened, for `envChanged`. */
  const [loadedVariables, setLoadedVariables] = useState<readonly string[]>([]);

  useEffect(() => {
    void window.tet.settings.get().then(setSettings);
    // Cannot change while the process runs.
    void window.tet.app.info().then(setInfo);
    void window.tet.environment.list().then((list) => {
      setVariables(atLeastOne(list.map((variable) => withId({ ...variable, from: variable.name, value: "" })), BLANK_ENV_ROW));
      setLoadedVariables(list.map((variable) => variable.name));
    });
  }, []);

  // Read once, on open; Save goes through patchSetting (commands.ts), which reads the file fresh
  // and leaves other keys alone. Keyed by id: the project list is rebuilt whole when a project is
  // added elsewhere, and a new object for the same project must not discard the edits.
  const activeProjectId = activeProject?.id;
  useEffect(() => {
    if (!activeProjectId) {
      loadedExplorer.current = null;
      setExplorerSettings(null);
      return;
    }
    void window.tet.repository.explorerSettings(activeProjectId).then((view) => {
      loadedExplorer.current = view;
      setExplorerSettings(view);
    });
  }, [activeProjectId]);

  useEscape(onClose);

  /** The Environment tab if touched, one tet.json write per changed Explorer key, then one
   *  settings.json write — last, since it applies at once (the theme among it) and Cancel could not
   *  take it back after a later write refused. What refuses it goes in the button row: it is about
   *  tet.json, not about one of the switches on the Files tab. */
  const { busy: saving, refused, submit: save, clear } = useSubmit(
    async () => {
      try {
        if (variablesEdited.current) {
          const rows = variables.map(envEdit).filter((edit): edit is EnvEdit => edit !== undefined);
          const refusal = await window.tet.environment.save(rows);
          if (refusal) {
            return refusal;
          }
          variablesEdited.current = false;
        }
        const loaded = loadedExplorer.current;
        if (activeProject && explorerSettings && loaded) {
          for (const key of EXPLORER_KEYS) {
            if (explorerSettings[key] === loaded[key]) {
              continue;
            }
            const refused = refusal(
              await window.tet.repository.setExplorerSetting(activeProject.id, key, explorerSettings[key]),
              "Could not update tet.json"
            );
            if (refused !== undefined) {
              return refused;
            }
          }
        }
        if (Object.keys(edits.current).length > 0) {
          await window.tet.settings.patch(edits.current);
        }
        return undefined;
      } catch (error) {
        // A throw would only clear the bar (useSubmit): said where a refusal is.
        return errorMessage(error);
      }
    },
    () => {
      onClose();
      // Asked after closing: a kind switch is saved either way, Cancel only waits for the next start.
      if (chosenKind !== shownKind) {
        void confirm({
          title: "Restart TET",
          message: `Restart TET now to switch to the ${chosenKind} theme?`,
          detail: "This ends every terminal in every project. Otherwise it applies at the next start.",
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
  const edit = (change: SettingsEdits): void => {
    edits.current = withSettings(edits.current, change);
    setSettings((current) => (current ? withSettings(current, change) : current));
    clear();
  };

  const flip = (key: keyof NotificationSettings, value: boolean): void => edit({ notifications: { [key]: value } });

  const applyPreset = (id: string): void => edit({ editorKeybindingPreset: id });

  const applyColorScheme = (scheme: ColorScheme): void => edit({ colorScheme: scheme });

  const applyTheme = (kind: ThemeKind, id: string): void => edit({ [themeKey(kind)]: id });

  // The kind shown now, and the one Save asks for — "system" resolved by the OS now (Electron's
  // prefers-color-scheme follows nativeTheme, which main.ts's currentTheme reads).
  const shownKind = resolveTheme(document.documentElement.dataset.theme).kind;
  const scheme = settings?.colorScheme ?? "system";
  const chosenKind = schemeKind(scheme, window.matchMedia("(prefers-color-scheme: dark)").matches);

  /** Tet's own text is stored as "", as in settings.ts; the reset button reads that. */
  const applyPrompt = (id: PromptId, text: string): void =>
    edit({ prompts: { [id]: text === DEFAULT_PROMPTS[id] ? "" : text } });

  const editExplorerSetting = <K extends keyof ExplorerSettings>(key: K, value: ExplorerSettings[K]): void => {
    setExplorerSettings((current) => (current ? { ...current, [key]: value } : current));
    clear();
  };

  const editVariables = (change: (rows: typeof variables) => typeof variables): void => {
    variablesEdited.current = true;
    setVariables(change);
    clear();
  };

  const envRowMarks = useMemo(() => envMarks(variables), [variables]);
  // As in the sbx dialog: Save waits for every marked row, and the tab repeats the mark.
  const blocked = envRowMarks.values().next().value;
  const tabs = useMemo(() => TABS.map((entry) => (entry.id === "environment" ? { ...entry, mark: blocked } : entry)), [blocked]);

  return (
    <DialogFrame
      header={{ tabs, active: tab, onSelect: setTab, onClose }}
      busy={saving}
      error={refused}
      message={envChanged(variables, loadedVariables) && <RestartNote />}
      className="settings-dialog"
      buttons={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          {/* Blocked by class: its tooltip is the reason (.button.disabled). */}
          <button
            type="button"
            className={blocked === undefined ? "button" : "button disabled"}
            disabled={saving}
            title={blocked}
            onClick={() => blocked === undefined && void save()}
          >
            Save
          </button>
        </>
      }
    >
      {tab === "appearance" && (
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
              value={resolveTheme(settings?.[themeKey(chosenKind)], chosenKind).id}
              onChange={(id) => applyTheme(chosenKind, id)}
              options={THEMES.filter((theme) => theme.kind === chosenKind).map((theme) => ({
                value: theme.id,
                label: theme.label
              }))}
            />
          </Field>
          {/* Live within one kind only: an agent gets light or dark when its tab starts
              (main.ts's applyTheme). */}
          {settings && chosenKind !== shownKind && (
            <p className="dialog-detail">Switching between light and dark applies after tet is restarted.</p>
          )}
        </>
      )}
      {tab === "notifications" && (
        <>
          <p className="dialog-detail">Desktop notifications for agent activity</p>
          {settings &&
            SWITCHES.map(({ key, label }) => (
              <Checkbox
                key={key}
                label={label}
                checked={settings.notifications[key]}
                onChange={(next) => flip(key, next)}
              />
            ))}
          {/* No restart caveat: hooks report every turn, and the toast reads the settings as they
              stand on arrival (session-manager's `toast`). */}
        </>
      )}
      {tab === "files" && (
        <>
          <p className="dialog-detail">
            {activeProject ? `EXPLORER tree, for ${activeProject.name}` : "EXPLORER tree - open a project to edit it"}
          </p>
          {activeProject && explorerSettings && (
            <>
              <Checkbox
                label="Hide what git ignores too"
                checked={explorerSettings.excludeGitIgnore}
                onChange={(next) => editExplorerSetting("excludeGitIgnore", next)}
              />
              <Checkbox
                label="Compact folders that only contain another folder into one row"
                checked={explorerSettings.compactFolders}
                onChange={(next) => editExplorerSetting("compactFolders", next)}
              />
              <Field label="Sort order">
                <Dropdown
                  value={explorerSettings.sortOrder}
                  onChange={(order) => editExplorerSetting("sortOrder", order)}
                  options={SORT_ORDERS.map((order) => ({ value: order.id, label: order.label }))}
                />
              </Field>
            </>
          )}
          <p className="dialog-detail">Presets from popular editors and IDEs - only for what the file editor supports</p>
          <Dropdown
            value={settings?.editorKeybindingPreset ?? DEFAULT_KEYBINDING_PRESET_ID}
            onChange={applyPreset}
            options={KEYBINDING_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
          />
        </>
      )}
      {tab === "prompts" && settings && (
        <>
          <div className="settings-prompt-header">
            <Dropdown
              value={promptId}
              onChange={setPromptId}
              options={PROMPT_IDS.map((id) => ({ value: id, label: PROMPT_LABELS[id] }))}
            />
            <button
              type="button"
              className="button secondary"
              disabled={settings.prompts[promptId] === ""}
              onClick={() => applyPrompt(promptId, "")}
            >
              Reset to default
            </button>
          </div>
          {/* Always the text the agent gets, never a placeholder. Read when the suggestion is
              asked for, so it applies on Save. */}
          <textarea
            className="settings-prompt"
            spellCheck={false}
            value={effectivePrompt(settings.prompts, promptId)}
            onChange={(event) => applyPrompt(promptId, event.target.value)}
          />
        </>
      )}
      {tab === "environment" && (
        <div className="settings-environment">
          <p className="dialog-detail">Stored on this machine and set in every tab but sandboxed ones, over the machine's own.</p>
          <RowSection
            label="Environment variables"
            rows={variables}
            renderRow={(row) => (
              <EditRow
                key={row.id}
                mark={envRowMarks.get(row.id)}
                remove="Remove variable"
                onRemove={() => editVariables((rows) => atLeastOne(without(rows, row.id), BLANK_ENV_ROW))}
              >
                <input
                  className="row-fill-input"
                  type="text"
                  placeholder="GITLAB_TOKEN"
                  title="The name every tab sees"
                  value={row.name}
                  onChange={(event) => editVariables((rows) => patched(rows, row.id, { name: event.target.value }))}
                />
                {row.overridesMachine && <OverridesMachine name={row.name} />}
                <SecretInput
                  stored={Boolean(row.from)}
                  value={row.value}
                  onChange={(value) => editVariables((rows) => patched(rows, row.id, { value }))}
                />
              </EditRow>
            )}
            add={
              <ActionLink
                onClick={() => editVariables((rows) => [...rows, withId(BLANK_ENV_ROW)])}
              >
                + Add variable
              </ActionLink>
            }
          />
        </div>
      )}
      {tab === "info" && info && (
        <div className="settings-info-columns">
          <div className="settings-info">
            <p className="dialog-detail">Versions</p>
            {INFO_ROWS.map(({ key, label }) => (
              <div key={key} className="settings-info-row">
                <span>{label}</span>
                <span>{info[key]}</span>
              </div>
            ))}
          </div>
          <div className="settings-shortcuts">
            <p className="dialog-detail">Shortcuts</p>
            {SHORTCUTS.map(({ id, description }) => (
              <div key={id} className="settings-shortcut-row">
                <span>{shortcutLabel(id)}</span>
                <span>{description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </DialogFrame>
  );
}
