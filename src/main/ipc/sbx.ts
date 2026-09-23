import { ipcMain } from "electron";
import { EMPTY_SBX_CONFIG } from "../../shared/types";
import type {
  GitActionResult,
  SbxKnowledgeSource,
  SbxLocalSave,
  SbxPath,
  SbxProjectConfig,
  SbxStatus,
  SbxStoredLocal
} from "../../shared/types";
import {
  cancelSbxSetup,
  initSbxPolicy,
  readKnowledgeSources,
  readLiveSbxConfig,
  readHostAllowed,
  readMountsAllowed,
  readSbxStatus,
  runSbxLogin
} from "../sbx";
import { saveProjectSbx } from "../sbx-settings";
import { MISSING_REPOSITORY, type IpcDeps } from "./deps";

/** The sandbox settings dialog: what sbx says, and what the project stores. */
export function registerSbxIpc({
  store,
  sbxLocal,
  send
}: Pick<IpcDeps, "store" | "sbxLocal" | "send">): void {
  // Per project: the policy has to allow the project's folder.
  ipcMain.handle("sbx:status", async (_event, projectId: string): Promise<SbxStatus> => {
    const project = store.get(projectId);
    return readSbxStatus(project?.path ?? "", projectId);
  });
  ipcMain.handle("sbx:login", () => runSbxLogin());
  ipcMain.handle("sbx:init-policy", () => initSbxPolicy());
  ipcMain.on("sbx:cancel-setup", () => cancelSbxSetup());

  // The Allowed paths rows' marks; asked fresh, as the policy changes outside tet.
  ipcMain.handle("sbx:mounts-allowed", (_event, paths: SbxPath[]): Promise<boolean[]> => readMountsAllowed(paths));
  // The Secrets rows' marks, likewise.
  ipcMain.handle("sbx:host-allowed", (_event, host: string): Promise<boolean> => readHostAllowed(host));

  // Read fresh; the hosts from the sandboxes themselves (sbx.ts's readLiveSbxConfig).
  ipcMain.handle("sbx:get-config", async (_event, projectId: string): Promise<SbxProjectConfig> => {
    const project = store.get(projectId);
    return project ? readLiveSbxConfig(project.path, project.id) : EMPTY_SBX_CONFIG;
  });
  // The Secrets and Variables rows holding a value on this machine, never the values; the knowledge.
  ipcMain.handle("sbx:stored", (_event, projectId: string): SbxStoredLocal => sbxLocal.stored(projectId));
  // The Knowledge tab's agents; asked fresh, as agents are installed outside tet.
  ipcMain.handle("sbx:knowledge-sources", (): Promise<SbxKnowledgeSource[]> => readKnowledgeSources());
  // The dialog's Save, shared with tet-ctl's sbx-set-* verbs (sbx-settings.ts).
  ipcMain.handle(
    "sbx:save-config",
    async (_event, projectId: string, request: SbxProjectConfig, local: SbxLocalSave): Promise<GitActionResult> => {
      const project = store.get(projectId);
      return project ? saveProjectSbx({ sbxLocal, send }, project, request, local) : { ok: false, error: MISSING_REPOSITORY.error };
    }
  );
}
