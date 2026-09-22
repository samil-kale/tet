import { ipcMain } from "electron";
import { getAgent } from "../agents";
import { EMPTY_SBX_CONFIG } from "../../shared/types";
import { errorMessage } from "../../shared/errors";
import type { GitActionResult, SbxLocalSave, SbxPath, SbxProjectConfig, SbxStatus, SbxStoredLocal } from "../../shared/types";
import {
  cancelSbxSetup,
  initSbxPolicy,
  readLiveSbxConfig,
  readHostAllowed,
  readMountsAllowed,
  readSbxStatus,
  runSbxLogin,
  saveSbxConfig
} from "../sbx";
import { MISSING_REPOSITORY, type IpcDeps } from "./deps";

/** The sandbox settings dialog: what sbx says, and what the project stores. */
export function registerSbxIpc({
  store,
  sbxSecrets,
  send
}: Pick<IpcDeps, "store" | "sbxSecrets" | "send">): void {
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
  // The Secrets and Variables rows holding a value on this machine; never the values.
  ipcMain.handle("sbx:stored", (_event, projectId: string): SbxStoredLocal => sbxSecrets.stored(projectId));
  // Stores the typed values first, so a machine without a keyring changes nothing; then
  // writes tet.json, a failure putting the values back. Notices for the sandboxes saveSbxConfig
  // removed, an error for what sbx refused.
  ipcMain.handle(
    "sbx:save-config",
    async (_event, projectId: string, request: SbxProjectConfig, local: SbxLocalSave): Promise<GitActionResult> => {
      const project = store.get(projectId);
      if (!project) {
        return { ok: false, error: MISSING_REPOSITORY.error };
      }
      const stored = sbxSecrets.encrypted(project.id);
      try {
        sbxSecrets.update(project.id, local, {
          secrets: request.secrets.map((secret) => secret.env),
          variables: request.variables.map((variable) => variable.env)
        });
        const { removed, failures } = await saveSbxConfig(
          project.path,
          project.id,
          request,
          sbxSecrets.values(project.id, "secrets"),
          new Set(Object.keys(local.secretValues))
        );
        for (const agentId of removed) {
          const message = request.enabled
            ? `The ${getAgent(agentId).displayName} sandbox of ${project.name} was removed and is rebuilt when its next tab starts.`
            : `The ${getAgent(agentId).displayName} sandbox of ${project.name} was removed.`;
          send("app:notice", { severity: "info", message });
        }
        if (failures.length > 0) {
          return { ok: false, error: `Saved, but not applied: ${failures.join(" ")}` };
        }
        return { ok: true };
      } catch (error) {
        sbxSecrets.restore(project.id, stored);
        return { ok: false, error: errorMessage(error) };
      }
    }
  );
}
