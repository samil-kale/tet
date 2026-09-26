import { app, ipcMain } from "electron";
import { listAgents } from "../agents";
import type { AppInfo, AppSettings, Requirements, SettingsEdits } from "../../shared/types";
import { markStartup, reportRendererSlow, reportRendererTask } from "../event-loop-monitor";
import { anyAgentInstalled, checkRequirements } from "../requirements";
import { augmentAgentPath } from "../terminals/agent-path";
import type { IpcDeps } from "./deps";

/** The startup gate, the app's own facts, the settings, and what the agents are. */
export function registerAppIpc({
  settings,
  sessions,
  openWorkspace,
  applyTheme,
  shutdown
}: Pick<IpcDeps, "settings" | "sessions" | "openWorkspace" | "applyTheme" | "shutdown">): void {
  /** The startup gate, asked on every re-check; passing opens the workspace. */
  ipcMain.handle("startup:check", async (): Promise<Requirements> => {
    // Re-scans for manager bin dirs created since startup, so "Check again" finds them.
    await markStartup("path", augmentAgentPath);
    const requirements = await markStartup("requirements", checkRequirements);
    if (requirements.met) {
      openWorkspace();
    }
    return requirements;
  });

  // Mid-session, so not the check above, which opens the workspace (anyAgentInstalled).
  ipcMain.handle("startup:any-agent-installed", () => anyAgentInstalled());

  ipcMain.on("startup:quit", () => app.quit());

  // The settings dialog's answer to a light/dark switch; it asked the user first.
  ipcMain.on("app:restart", () => shutdown(true));

  // The settings Info tab, fixed for the process's life.
  ipcMain.handle(
    "app:info",
    (): AppInfo => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      os: `${process.platform} ${process.arch}`
    })
  );

  ipcMain.on("app:long-task", (_event, ms: number, context: string) => {
    if (typeof ms === "number" && Number.isFinite(ms)) {
      reportRendererTask(ms, typeof context === "string" ? context : "");
    }
  });

  ipcMain.on("app:slow", (_event, label: string, ms: number) => {
    if (typeof label === "string" && typeof ms === "number" && Number.isFinite(ms)) {
      reportRendererSlow(label, ms);
    }
  });

  ipcMain.handle("settings:get", (): AppSettings => settings.get());

  // Only the keys the dialog touched. It says itself when a theme waits for a restart.
  ipcMain.handle("settings:patch", (_event, edits: SettingsEdits): void => {
    settings.patch(edits);
    applyTheme();
    if (edits.notifications?.idleReminder !== undefined) {
      sessions.idleReminderChanged();
    }
  });

  ipcMain.handle("agents:list", () => listAgents());
}
