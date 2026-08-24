import { useEffect, useState } from "react";
import { SYSTEM_THEME_ID, THEMES } from "../../shared/themes";
import { DEFAULT_KEYBINDING_PRESET_ID, THEMED_AGENT_IDS } from "../../shared/types";
import type {
  AgentInfo,
  AppInfo,
  AppSettings,
  ExplorerSettings,
  ExplorerSortOrder,
  GitActionResult,
  NotificationSettings,
  Project,
  ThemedAgentId
} from "../../shared/types";
import { Dropdown } from "./Dropdown";
import { KEYBINDING_PRESETS } from "../keybinding-presets";
import { notify } from "./Notices";
import { SHORTCUTS, shortcutLabel } from "../shortcuts";
import { useEscape } from "./use-escape";

interface SettingsDialogProps {
  /** Whose tet.json the Files tab's Explorer settings read and write; null hides that part. */
  activeProject: Project | null;
  onClose: () => void;
}

type SettingsTab = "appearance" | "notifications" | "shortcuts" | "files" | "info";

/** The dialog's panes, in the order they are worth opening; the first is the one it opens on. */
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "files", label: "Files" },
  { id: "info", label: "Info" }
];

/** One switch per line, in the order they matter: the turn ended, it is stuck, it is idle. */
const SWITCHES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "finished", label: "Finished — the turn ended and nothing it started is still running" },
  { key: "needsYou", label: "Action needed — waiting on a permission prompt or a question" },
  { key: "idleReminder", label: "Still waiting — no new prompt for a while" }
];

/**
 * The Files tab's sort-order picker. `foldersNestsFiles` is left out on purpose: the Explorer
 * tree has no file nesting to turn off, so it sorts identically to `default` and would be a
 * second, indistinguishable entry — a hand-written tet.json can still hold it.
 */
const SORT_ORDERS: { id: ExplorerSortOrder; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "mixed", label: "Mixed" },
  { id: "filesFirst", label: "Files First" },
  { id: "type", label: "Type" },
  { id: "modified", label: "Modified" }
];

/** The Info tab's rows, in the order the versions nest: tet, then what it runs on. */
const INFO_ROWS: { key: keyof AppInfo; label: string }[] = [
  { key: "version", label: "TET" },
  { key: "electron", label: "Electron" },
  { key: "chromium", label: "Chromium" },
  { key: "node", label: "Node" },
  { key: "os", label: "Platform" }
];

/**
 * Everything tet keeps about itself rather than about one repository. Opened from the title
 * bar, over the whole window like the diff.
 *
 * Not part of Dialog.tsx: that file puts *questions* and is built around a form with two
 * buttons. This asks nothing — every switch applies the moment it is flipped, the way VS Code's
 * own settings do, so there is nothing to confirm and nothing to take back.
 */
export function SettingsDialog({ activeProject, onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(TABS[0].id);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [explorerSettings, setExplorerSettings] = useState<ExplorerSettings | null>(null);
  /** For the Appearance tab's agent labels — the `displayName`s live on the AgentDefinitions. */
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    void window.tet.settings.get().then(setSettings);
    // Asked alongside the settings rather than when the Info tab is first opened: none of it can
    // change while the process runs, so there is nothing a later read would catch.
    void window.tet.app.info().then(setInfo);
    void window.tet.agents.list().then(setAgents);
  }, []);

  // The active project's Explorer settings — read on open and again whenever its tet.json
  // changes underneath, whoever wrote it (the tree's own menu, an editor, an agent).
  useEffect(() => {
    if (!activeProject) {
      setExplorerSettings(null);
      return;
    }
    const projectId = activeProject.id;
    void window.tet.repository.explorerSettings(projectId).then(setExplorerSettings);
    return window.tet.commands.onChanged((payload) => {
      if (payload.projectId === projectId) {
        void window.tet.repository.explorerSettings(projectId).then(setExplorerSettings);
      }
    });
  }, [activeProject]);

  useEscape(onClose);

  const flip = (key: keyof NotificationSettings, value: boolean): void => {
    if (!settings) {
      return;
    }
    const next: AppSettings = { ...settings, notifications: { ...settings.notifications, [key]: value } };
    setSettings(next);
    void window.tet.settings.save(next);
  };

  const applyPreset = (id: string): void => {
    if (!settings) {
      return;
    }
    const next: AppSettings = { ...settings, editorKeybindingPreset: id };
    setSettings(next);
    void window.tet.settings.save(next);
  };

  const applyTheme = (id: string): void => {
    if (!settings) {
      return;
    }
    const next: AppSettings = { ...settings, theme: id };
    setSettings(next);
    void window.tet.settings.save(next);
  };

  const applyThemeAgent = (id: ThemedAgentId, value: boolean): void => {
    if (!settings) {
      return;
    }
    const next: AppSettings = { ...settings, themeAgents: { ...settings.themeAgents, [id]: value } };
    setSettings(next);
    void window.tet.settings.save(next);
  };

  const updateExplorerSettings = <K extends keyof ExplorerSettings>(
    key: K,
    value: ExplorerSettings[K],
    save: (projectId: string, value: ExplorerSettings[K]) => Promise<GitActionResult>
  ): void => {
    if (!activeProject || !explorerSettings) {
      return;
    }
    setExplorerSettings({ ...explorerSettings, [key]: value });
    void save(activeProject.id, value).then((result) => {
      if (!result.ok) {
        notify("error", result.error ?? "Could not update tet.json");
      }
    });
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog wide settings-dialog">
        {/* The tabs head the dialog instead of a title, as in the add-repository dialog: the
            selected one names what is below it, and "Settings" is what the button that opened
            this says. */}
        <div className="dialog-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? "dialog-tab active" : "dialog-tab"}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="dialog-body">
          {tab === "appearance" && (
            <>
              <label className="dialog-field">
                <span>Color theme</span>
                <Dropdown
                  value={settings?.theme ?? SYSTEM_THEME_ID}
                  onChange={applyTheme}
                  options={[
                    { value: SYSTEM_THEME_ID, label: "System" },
                    ...THEMES.map((theme) => ({ value: theme.id, label: theme.label }))
                  ]}
                />
              </label>
              <p className="dialog-detail">Apply theme to</p>
              {settings &&
                THEMED_AGENT_IDS.map((id) => (
                  <label key={id} className="dialog-checkbox">
                    <input
                      type="checkbox"
                      checked={settings.themeAgents[id]}
                      onChange={(event) => applyThemeAgent(id, event.target.checked)}
                    />
                    <span>{agents.find((agent) => agent.id === id)?.displayName ?? id}</span>
                  </label>
                ))}
              {/* Not live, for the same reason the notifications below aren't: xterm, shiki and
                  monaco each read the theme once and keep it, as does the window's own chrome;
                  the agents are handed it when their first terminal in a project starts. */}
              <p className="dialog-detail">Applies after tet is restarted.</p>
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
              {/* Said out loud because it is not what a switch usually promises: an agent is handed
                  its notification setup once per project, when its first terminal there starts —
                  Claude Code as the settings file it reads once, opencode as what its event stream
                  is wired to — and neither can be reached afterwards. */}
              <p className="dialog-detail">
                Handed to an agent when its first terminal in a project starts - a change reaches
                already-open projects only after tet is restarted.
              </p>
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
                      onChange={(event) =>
                        updateExplorerSettings(
                          "excludeGitIgnore",
                          event.target.checked,
                          window.tet.repository.setExcludeGitIgnore
                        )
                      }
                    />
                    <span>Hide what git ignores too</span>
                  </label>
                  <label className="dialog-checkbox">
                    <input
                      type="checkbox"
                      checked={explorerSettings.compactFolders}
                      onChange={(event) =>
                        updateExplorerSettings(
                          "compactFolders",
                          event.target.checked,
                          window.tet.repository.setCompactFolders
                        )
                      }
                    />
                    <span>Compact folders that only contain another folder into one row</span>
                  </label>
                  <label className="dialog-field">
                    <span>Sort order</span>
                    <Dropdown
                      value={explorerSettings.sortOrder}
                      onChange={(order) =>
                        updateExplorerSettings(
                          "sortOrder",
                          order as ExplorerSortOrder,
                          window.tet.repository.setSortOrder
                        )
                      }
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
        </div>
        <div className="dialog-buttons">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
