import { handle } from "./channels";
import { errorMessage } from "../../shared/errors";
import type { GitActionResult } from "../../shared/types/git";
import type { ProjectCommand, ProjectRef } from "../../shared/types/project";
import type { TabDescriptor } from "../../shared/types/terminals";
import { readCommands, writeCommands } from "../store/tet-json";
import { PROJECT_NOT_FOUND } from "../store/resolved-ref";
import type { IpcDeps } from "./deps";

/** The project's saved commands (tet.json), and running one in a tab of its own. */
export function registerCommandsIpc({ store, tabManagers }: Pick<IpcDeps, "store" | "tabManagers">): void {
  handle("commands:list", async (_event, projectId: string): Promise<ProjectCommand[]> => {
    const project = store.get(projectId);
    return project ? readCommands(project.path) : [];
  });

  // The failure is answered, not notified: the dialog that asked for the command is still up and
  // shows it at its field (`prompt`'s `submit`); a reorder or a remove notifies it itself.
  handle("commands:save", async (_event, projectId: string, commands: ProjectCommand[]): Promise<GitActionResult> => {
    const project = store.get(projectId);
    if (!project) {
      return { ok: false, error: PROJECT_NOT_FOUND };
    }
    try {
      await writeCommands(project.path, commands);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `Could not save commands: ${errorMessage(error)}` };
    }
  });

  /** Opens a tab whose process is the command. */
  handle("commands:run", (_event, ref: ProjectRef, command: ProjectCommand): TabDescriptor | null => {
    return tabManagers.get(ref)?.createCommandTab(command) ?? null;
  });
}
