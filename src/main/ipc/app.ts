import * as os from "node:os";
import { app } from "electron";
import { handle, on } from "./channels";
import { getAgent, listAgents, listAskableAgents, listAskModels } from "../agents";
import type { AgentId, AskModelsResult, Requirements } from "../../shared/types/agents";
import type { AppInfo } from "../../shared/types/app";
import type { AppSettings, SettingsEdits } from "../../shared/types/settings";
import { anyAgentInstalled, checkRequirements } from "../requirements";
import { augmentAgentPath } from "../agents/agent-path";
import type { IpcDeps } from "./deps";
import { PLATFORM } from "../util/host-platform";

/** The startup gate, the app's own facts, the settings, and what the agents are. */
export function registerAppIpc({
  settings,
  openWorkspace,
  shutdown
}: Pick<IpcDeps, "settings" | "openWorkspace" | "shutdown">): void {
  /** The startup gate, asked on every re-check; passing opens the workspace. */
  handle("startup:check", async (): Promise<Requirements> => {
    // Re-scans for manager bin dirs created since startup, so "Check again" finds them.
    await augmentAgentPath();
    const requirements = await checkRequirements();
    if (requirements.met) {
      await openWorkspace();
    }
    return requirements;
  });

  // Mid-session, so not the check above, which opens the workspace (anyAgentInstalled).
  handle("startup:any-agent-installed", () => anyAgentInstalled());

  on("startup:quit", () => app.quit());

  // The settings dialog's answer to a light/dark switch; it asked the user first.
  on("app:restart", () => shutdown(true));

  // The settings Info tab, fixed for the process's life.
  handle(
    "app:info",
    (): AppInfo => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      os: `${PLATFORM.id} ${process.arch}`
    })
  );

  handle("settings:get", (): AppSettings => settings.get());

  // Only the keys the dialog touched. It says itself when a theme waits for a restart.
  handle("settings:patch", (_event, edits: SettingsEdits): void => {
    settings.patch(edits);
  });

  handle("agents:list", () => listAgents());

  // The settings Prompts tab's picker, which belongs to no project.
  handle("agents:askable", (): Promise<AgentId[]> => listAskableAgents(os.tmpdir()));
  handle("agents:ask-models", (_event, agentId: AgentId): Promise<AskModelsResult> => listAskModels(getAgent(agentId), os.tmpdir()));
}
