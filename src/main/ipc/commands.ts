import { ipcMain } from "electron";
import type { ProjectCommand, TerminalDescriptor } from "../../shared/types";
import { readCommands, writeCommands } from "../git/commands";
import type { IpcDeps } from "./deps";

/** The project's saved commands (tet.json), and running one in a tab of its own. */
export function registerCommandsIpc({
  store,
  sessions,
  send
}: Pick<IpcDeps, "store" | "sessions" | "send">): void {
  ipcMain.handle("commands:list", async (_event, projectId: string): Promise<ProjectCommand[]> => {
    const project = store.get(projectId);
    return project ? readCommands(project.path) : [];
  });

  ipcMain.handle("commands:save", async (_event, projectId: string, commands: ProjectCommand[]): Promise<void> => {
    const project = store.get(projectId);
    if (!project) {
      return;
    }
    try {
      await writeCommands(project.path, commands);
    } catch (error) {
      send("app:notice", { severity: "error", message: `Could not save commands: ${String(error)}` });
    }
  });

  /** Opens a tab whose process is the command. */
  ipcMain.handle(
    "commands:run",
    (_event, projectId: string, command: ProjectCommand): TerminalDescriptor | null => {
      return sessions.get(projectId)?.createCommandTab(command) ?? null;
    }
  );
}
