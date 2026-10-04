import { handle, on } from "./channels";
import { errorMessage } from "../../shared/errors";
import { EMPTY_SBX_SETTINGS } from "../../shared/types/sbx";
import type { SbxAccount, SbxAccountEdit, SbxKnowledgeSettings, SbxKnowledgeSource, SbxLocalSave, SbxProblems, SbxProjectSettings, SbxSaveResult, SbxSignInResult, SbxStatus, SbxStoredLocal, SbxValueKind } from "../../shared/types/sbx";
import { cancelSbxSetup, initSbxPolicy, readSbxUser, runSbxSignIn, runSbxSignOut } from "../sbx/sbx-cli";
import { readKnowledgeSources } from "../sbx/sbx-mounts";
import { readSbxStatus } from "../sbx/sbx-status";
import { signInToSbx } from "../sbx/sbx-accounts";
import { readProjectSbxProblems, saveProjectSbx } from "../sbx/sbx-settings";
import { readSbxSettings } from "../store/tet-json";
import { PROJECT_NOT_FOUND } from "../store/resolved-ref";
import type { IpcDeps } from "./deps";

/** The sandbox settings dialog: what sbx says, and what the project stores. */
export function registerSbxIpc({
  store,
  sbxLocal,
  sbxAccounts,
  notice
}: Pick<IpcDeps, "store" | "sbxLocal" | "sbxAccounts" | "notice">): void {
  // Per project: the policy has to allow the repository's folder.
  handle("sbx:status", async (_event, projectId: string): Promise<SbxStatus> => {
    const project = store.get(projectId);
    return project
      ? readSbxStatus(project.path, { projectId })
      : { installed: false, signedIn: false, policyInitialized: false, blockers: [], failure: PROJECT_NOT_FOUND };
  });

  // The General tab's Docker account (sbx-accounts.ts); its access tokens are one list for every
  // project.
  handle("sbx:sign-in-browser", () => runSbxSignIn());
  handle("sbx:signed-in-user", () => readSbxUser(true));
  handle(
    "sbx:sign-in",
    (_event, user: string, token: string, accountId?: string): Promise<SbxSignInResult> =>
      signInToSbx(sbxAccounts, user, token, accountId)
  );
  handle("sbx:sign-out", () => runSbxSignOut());
  handle("sbx:accounts", (): SbxAccount[] => sbxAccounts.list());
  handle("sbx:save-accounts", (_event, edits: SbxAccountEdit[]): string | undefined => {
    try {
      sbxAccounts.update(edits);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  });
  handle("sbx:init-policy", () => initSbxPolicy());
  on("sbx:cancel-setup", () => cancelSbxSetup());

  // The rows' marks; asked fresh, as the policy and this machine change outside TET.
  handle(
    "sbx:problems",
    async (
      _event,
      projectId: string,
      settings: SbxProjectSettings,
      knowledge: SbxKnowledgeSettings,
      values: Record<SbxValueKind, string[]>,
      status: Pick<SbxStatus, "organization">
    ): Promise<SbxProblems> => {
      const project = store.get(projectId);
      return project ? readProjectSbxProblems(project, settings, knowledge, values, status && { status }) : {};
    }
  );

  // Read fresh: tet.json may be edited outside TET.
  handle("sbx:get-settings", async (_event, projectId: string): Promise<SbxProjectSettings> => {
    const project = store.get(projectId);
    return project ? readSbxSettings(project.path) : EMPTY_SBX_SETTINGS;
  });
  // The Secrets and Variables rows holding a value on this machine, never the values; the knowledge.
  handle("sbx:stored", (_event, projectId: string): SbxStoredLocal => sbxLocal.stored(projectId));
  // The Knowledge tab's agents; asked fresh, as agents are installed outside TET.
  handle("sbx:knowledge-sources", (): Promise<SbxKnowledgeSource[]> => readKnowledgeSources());
  // The dialog's Save, shared with tet-ctl's sbx-set-* verbs (sbx-settings.ts).
  handle(
    "sbx:save-settings",
    async (_event, projectId: string, request: SbxProjectSettings, local: SbxLocalSave): Promise<SbxSaveResult> => {
      const project = store.get(projectId);
      return project ? saveProjectSbx({ sbxLocal, notice }, project, request, local) : { ok: false, error: PROJECT_NOT_FOUND };
    }
  );
}
