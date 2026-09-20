import { ipcMain } from "electron";
import type { GitActionResult, ProjectCommand, TerminalDescriptor } from "../../shared/types";
import { readCommands, writeCommands } from "../tet-json";
import { MISSING_REPOSITORY, type IpcDeps } from "./deps";

/** The project's saved commands (tet.json), and running one in a tab of its own. */
export function registerCommandsIpc({ store, sessions }: Pick<IpcDeps, "store" | "sessions">): void {
  ipcMain.handle("commands:list", async (_event, projectId: string): Promise<ProjectCommand[]> => {
    const project = store.get(projectId);
    return project ? readCommands(project.path) : [];
  });

  // The failure is answered, not notified: the dialog that asked for the command is still up and
  // shows it at its field (`prompt`'s `submit`); a reorder or a remove notifies it itself.
  ipcMain.handle(
    "commands:save",
    async (_event, projectId: string, commands: ProjectCommand[]): Promise<GitActionResult> => {
      const project = store.get(projectId);
      if (!project) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      try {
        await writeCommands(project.path, commands);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `Could not save commands: ${String(error)}` };
      }
    }
  );

  /** Opens a tab whose process is the command. */
  ipcMain.handle(
    "commands:run",
    (_event, projectId: string, command: ProjectCommand): TerminalDescriptor | null => {
      return sessions.get(projectId)?.createCommandTab(command) ?? null;
    }
  );
}
