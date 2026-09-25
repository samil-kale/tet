import { ipcMain } from "electron";
import { errorMessage } from "../../shared/errors";
import { EMPTY_SBX_CONFIG } from "../../shared/types";
import type {
  SbxAccount,
  SbxAccountEdit,
  SbxKnowledgeConfig,
  SbxKnowledgeSource,
  SbxLocalSave,
  SbxProblems,
  SbxProjectConfig,
  SbxSaveResult,
  SbxSignInResult,
  SbxStatus,
  SbxStoredLocal,
  SbxValueKind
} from "../../shared/types";
import {
  cancelSbxSetup,
  initSbxPolicy,
  readKnowledgeSources,
  readSbxStatus,
  readSbxUser,
  runSbxLogin,
  runSbxLogout
} from "../sbx";
import { signInToSbx } from "../sbx-accounts";
import { readProjectSbxProblems, saveProjectSbx } from "../sbx-settings";
import { readSbxConfig } from "../tet-json";
import { MISSING_REPOSITORY, type IpcDeps } from "./deps";

/** The sandbox settings dialog: what sbx says, and what the project stores. */
export function registerSbxIpc({
  store,
  sbxLocal,
  sbxAccounts,
  notice
}: Pick<IpcDeps, "store" | "sbxLocal" | "sbxAccounts" | "notice">): void {
  // Per project: the policy has to allow the project's folder.
  ipcMain.handle("sbx:status", async (_event, projectId: string): Promise<SbxStatus> => {
    const project = store.get(projectId);
    return project
      ? readSbxStatus(project.path, projectId)
      : { installed: false, loggedIn: false, policyInitialized: false, blockers: [], failure: MISSING_REPOSITORY.error };
  });

  // The General tab's Docker account (sbx-accounts.ts); its access tokens are one list for every
  // project.
  ipcMain.handle("sbx:login", () => runSbxLogin());
  ipcMain.handle("sbx:signed-in-user", () => readSbxUser(true));
  ipcMain.handle(
    "sbx:sign-in",
    (_event, user: string, token: string, accountId?: string): Promise<SbxSignInResult> =>
      signInToSbx(sbxAccounts, user, token, accountId, true)
  );
  ipcMain.handle("sbx:logout", () => runSbxLogout());
  ipcMain.handle("sbx:accounts", (): SbxAccount[] => sbxAccounts.list());
  ipcMain.handle("sbx:save-accounts", (_event, edits: SbxAccountEdit[]): string | undefined => {
    try {
      sbxAccounts.update(edits);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  });
  ipcMain.handle("sbx:init-policy", () => initSbxPolicy());
  ipcMain.on("sbx:cancel-setup", () => cancelSbxSetup());

  // The rows' marks; asked fresh, as the policy and this machine change outside tet.
  ipcMain.handle(
    "sbx:problems",
    async (
      _event,
      projectId: string,
      config: SbxProjectConfig,
      knowledge: SbxKnowledgeConfig,
      values: Record<SbxValueKind, string[]>
    ): Promise<SbxProblems> => {
      const project = store.get(projectId);
      return project ? readProjectSbxProblems(project, config, knowledge, values) : {};
    }
  );

  // Read fresh: tet.json may be edited outside tet.
  ipcMain.handle("sbx:get-config", async (_event, projectId: string): Promise<SbxProjectConfig> => {
    const project = store.get(projectId);
    return project ? readSbxConfig(project.path) : EMPTY_SBX_CONFIG;
  });
  // The Secrets and Variables rows holding a value on this machine, never the values; the knowledge.
  ipcMain.handle("sbx:stored", (_event, projectId: string): SbxStoredLocal => sbxLocal.stored(projectId));
  // The Knowledge tab's agents; asked fresh, as agents are installed outside tet.
  ipcMain.handle("sbx:knowledge-sources", (): Promise<SbxKnowledgeSource[]> => readKnowledgeSources());
  // The dialog's Save, shared with tet-ctl's sbx-set-* verbs (sbx-settings.ts).
  ipcMain.handle(
    "sbx:save-config",
    async (_event, projectId: string, request: SbxProjectConfig, local: SbxLocalSave): Promise<SbxSaveResult> => {
      const project = store.get(projectId);
      return project ? saveProjectSbx({ sbxLocal, notice }, project, request, local) : { ok: false, error: MISSING_REPOSITORY.error };
    }
  );
}
