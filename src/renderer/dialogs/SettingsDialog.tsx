import { useEffect, useRef, useState } from "react";
import { DEFAULT_PROMPTS, effectivePrompt } from "../../shared/prompts";
import { resolveTheme, schemeKind, themeKey, THEMES, type ThemeKind } from "../../shared/themes";
import { COLOR_SCHEMES, DEFAULT_KEYBINDING_PRESET_ID, PROMPT_IDS } from "../../shared/types";
import type {
  AppInfo,
  AppSettings,
  ColorScheme,
  ExplorerSettings,
  ExplorerSortOrder,
  NotificationSettings,
  Project,
  PromptId
} from "../../shared/types";
import { DialogFrame } from "../ui/DialogFrame";
import { Dropdown } from "../ui/Dropdown";
import { KEYBINDING_PRESETS } from "../diff/keybinding-presets";
import { notify } from "../ui/Notices";
import { SHORTCUTS, shortcutLabel } from "../shortcuts";
import { useEscape } from "../ui/use-escape";

interface SettingsDialogProps {
  /** Whose tet.json the Files tab's Explorer settings read and write; null hides that part. */
  activeProject: Project | null;
  onClose: () => void;
}

type SettingsTab = "appearance" | "notifications" | "shortcuts" | "files" | "prompts" | "info";

/** The dialog's panes; the first is the one it opens on. */
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "files", label: "Files" },
  { id: "prompts", label: "Prompts" },
  { id: "info", label: "Info" }
];

/** The Appearance tab's radio buttons. */
const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark"
};

/** The Prompts tab's picker, one label per question. */
const PROMPT_LABELS: Record<PromptId, string> = {
  commitMessage: "Commit message"
};

/** One switch per line: the turn ended, it is stuck, it is idle. */
const SWITCHES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "finished", label: "Finished — the turn ended and nothing it started is still running" },
  { key: "needsYou", label: "Action needed — waiting on a permission prompt or a question" },
  // The one switch that is not live: its hook is registered per tab, since nothing but the
  // toast comes of it (AgentPaths.idleReminder).
  { key: "idleReminder", label: "Still waiting — no new prompt for a while (Claude Code only, from the next tab on)" }
];

/**
 * The Files tab's sort-order picker. `foldersNestsFiles` is left out: the Explorer tree has no
 * file nesting, so it sorts identically to `default`. A hand-written tet.json can still hold it.
 */
const SORT_ORDERS: { id: ExplorerSortOrder; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "mixed", label: "Mixed" },
  { id: "filesFirst", label: "Files First" },
  { id: "type", label: "Type" },
  { id: "modified", label: "Modified" }
];

/** The Files tab's own keys, one write each — in the order Save goes through them. */
const EXPLORER_KEYS: (keyof ExplorerSettings)[] = ["excludeGitIgnore", "compactFolders", "sortOrder"];

/** The Info tab's rows: tet, then what it runs on. */
const INFO_ROWS: { key: keyof AppInfo; label: string }[] = [
  { key: "version", label: "TET" },
  { key: "electron", label: "Electron" },
  { key: "chromium", label: "Chromium" },
  { key: "node", label: "Node" },
  { key: "os", label: "Platform" }
];

/**
 * Everything tet keeps about itself rather than about one repository. Not part of Dialog.tsx:
 * this asks nothing — it edits its own copy of the settings and writes on Save, like every
 * other dialog. Cancel and Escape drop what was edited.
 */
export function SettingsDialog({ activeProject, onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(TABS[0].id);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [explorerSettings, setExplorerSettings] = useState<ExplorerSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [promptId, setPromptId] = useState<PromptId>(PROMPT_IDS[0]);
  /** What tet.json held when the dialog opened: Save writes only the keys that differ from it. */
  const loadedExplorer = useRef<ExplorerSettings | null>(null);

  useEffect(() => {
    void window.tet.settings.get().then(setSettings);
    // Asked alongside the settings: none of it can change while the process runs.
    void window.tet.app.info().then(setInfo);
  }, []);

  // Read once, on open. Nothing follows tet.json while the dialog stands: Save reaches the file
  // through patchSetting (commands.ts), which reads it fresh and leaves every other key alone.
  // By id: the project list is rebuilt whole when a project is added elsewhere, and a new object
  // for the same project must not throw away what was edited here.
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

  /** Edits the dialog's own copy; settings.json is written whole on Save (see settings.ts). */
  const patch = (change: (current: AppSettings) => Partial<AppSettings>): void =>
    setSettings((current) => (current ? { ...current, ...change(current) } : current));

  const flip = (key: keyof NotificationSettings, value: boolean): void =>
    patch((current) => ({ notifications: { ...current.notifications, [key]: value } }));

  const applyPreset = (id: string): void => patch(() => ({ editorKeybindingPreset: id }));

  const applyColorScheme = (scheme: ColorScheme): void => patch(() => ({ colorScheme: scheme }));

  const applyTheme = (kind: ThemeKind, id: string): void =>
    patch(() => ({ [themeKey(kind)]: id }));

  // The kind the window is drawn in, and the one Save would ask for — "system" answered by the OS as
  // it is now (Electron's prefers-color-scheme follows nativeTheme, which main.ts's currentTheme reads).
  const shownKind = resolveTheme(document.documentElement.dataset.theme).kind;
  const scheme = settings?.colorScheme ?? "system";
  const chosenKind = schemeKind(scheme, window.matchMedia("(prefers-color-scheme: dark)").matches);

  /** Tet's own text is stored as "" (settings.ts does the same); the reset button reads off it. */
  const applyPrompt = (id: PromptId, text: string): void =>
    patch((current) => ({ prompts: { ...current.prompts, [id]: text === DEFAULT_PROMPTS[id] ? "" : text } }));

  const editExplorerSetting = <K extends keyof ExplorerSettings>(key: K, value: ExplorerSettings[K]): void =>
    setExplorerSettings((current) => (current ? { ...current, [key]: value } : current));

  /** One write of settings.json, then one of tet.json per Explorer key the dialog changed. */
  const save = async (): Promise<void> => {
    setSaving(true);
    if (settings) {
      await window.tet.settings.save(settings);
    }
    const loaded = loadedExplorer.current;
    if (activeProject && explorerSettings && loaded) {
      for (const key of EXPLORER_KEYS) {
        if (explorerSettings[key] === loaded[key]) {
          continue;
        }
        const result = await window.tet.repository.setExplorerSetting(activeProject.id, key, explorerSettings[key]);
        if (!result.ok) {
          notify("error", result.error ?? "Could not update tet.json");
          setSaving(false);
          return;
        }
      }
    }
    setSaving(false);
    onClose();
  };

  return (
    // The tabs head the dialog instead of a title, as in the add-repository dialog.
    <DialogFrame
      header={{ tabs: TABS, active: tab, onSelect: setTab, onClose }}
      className="wide settings-dialog"
      buttons={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      {tab === "appearance" && (
        <>
          <p className="dialog-detail">Color scheme</p>
          <div className="settings-color-schemes">
            {COLOR_SCHEMES.map((option) => (
              <label key={option} className="dialog-checkbox">
                <input
                  type="radio"
                  name="color-scheme"
                  checked={scheme === option}
                  onChange={() => applyColorScheme(option)}
                />
                <span>{COLOR_SCHEME_LABELS[option]}</span>
              </label>
            ))}
          </div>
          <label className="dialog-field">
            <span>{chosenKind === "dark" ? "Dark theme" : "Light theme"}</span>
            <Dropdown
              value={resolveTheme(settings?.[themeKey(chosenKind)], chosenKind).id}
              onChange={(id) => applyTheme(chosenKind, id)}
              options={THEMES.filter((theme) => theme.kind === chosenKind).map((theme) => ({
                value: theme.id,
                label: theme.label
              }))}
            />
          </label>
          {/* Live within one kind only: an agent is handed light or dark when its tab starts, and
              one already running would go on drawing for the other (main.ts's applyTheme). */}
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
              <label key={key} className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={settings.notifications[key]}
                  onChange={(event) => flip(key, event.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          {/* No caveat to make: an agent's hooks report every turn either way, and the toast is
              composed when the report arrives (session-manager's `toast`), off the settings as
              they stand at that moment. */}
        </>
      )}
      {tab === "shortcuts" && (
        <div className="settings-shortcuts">
          {SHORTCUTS.map(({ id, description }) => (
            <div key={id} className="settings-shortcut-row">
              <span>{shortcutLabel(id)}</span>
              <span>{description}</span>
            </div>
          ))}
        </div>
      )}
      {tab === "files" && (
        <>
          <p className="dialog-detail">
            {activeProject ? `EXPLORER tree, for ${activeProject.name}` : "EXPLORER tree - open a project to edit it"}
          </p>
          {activeProject && explorerSettings && (
            <>
              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={explorerSettings.excludeGitIgnore}
                  onChange={(event) => editExplorerSetting("excludeGitIgnore", event.target.checked)}
                />
                <span>Hide what git ignores too</span>
              </label>
              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={explorerSettings.compactFolders}
                  onChange={(event) => editExplorerSetting("compactFolders", event.target.checked)}
                />
                <span>Compact folders that only contain another folder into one row</span>
              </label>
              <label className="dialog-field">
                <span>Sort order</span>
                <Dropdown
                  value={explorerSettings.sortOrder}
                  onChange={(order) => editExplorerSetting("sortOrder", order as ExplorerSortOrder)}
                  options={SORT_ORDERS.map((order) => ({ value: order.id, label: order.label }))}
                />
              </label>
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
              onChange={(id) => setPromptId(id as PromptId)}
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
          {/* Always the text the agent will get, never a placeholder. Read at the moment the
              commit-message suggestion is asked for, so Save is all it takes — unlike
              everything else here. */}
          <textarea
            className="settings-prompt"
            spellCheck={false}
            value={effectivePrompt(settings.prompts, promptId)}
            onChange={(event) => applyPrompt(promptId, event.target.value)}
          />
        </>
      )}
      {tab === "info" && info && (
        <div className="settings-info">
          {INFO_ROWS.map(({ key, label }) => (
            <div key={key} className="settings-info-row">
              <span>{label}</span>
              <span>{info[key]}</span>
            </div>
          ))}
        </div>
      )}
    </DialogFrame>
  );
}
