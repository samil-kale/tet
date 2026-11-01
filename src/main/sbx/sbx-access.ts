import type { NoticeSeverity } from "../../shared/types/app";
import type { Project } from "../../shared/types/project";
import type {
  SbxAccount,
  SbxRegisteredMcp,
  SbxSkillsSettings,
  SbxLocalSave,
  SbxProblems,
  SbxProjectSettings,
  SbxSaveResult,
  SbxSignInResult,
  SbxStoredLocal,
} from "../../shared/types/sbx";
import { readSbxSettings } from "../store/tet-json";
import { signInToSbx, type SbxAccountStore } from "./sbx-accounts";
import { readSbxUser } from "./sbx-cli";
import type { SbxLocalStore } from "./sbx-local";
import { readRegisteredMcp, signInMcp } from "./sbx-mcp";
import { readProjectSbxProblems, saveProjectSbx } from "./sbx-settings";
import { readSbxReading, readSbxSignedIn, type SbxReading } from "./sbx-status";

/** The SBX Settings dialog's reads and Save (ipc/sbx.ts, sbx-settings.ts), as tet-ctl's verbs take
 *  them (ControlDeps.sbx). */
export interface SbxAccess {
  /** sbx-status.ts's readSbxReading: the status, and what the verb's problems check reuses of it. */
  status(project: Project): Promise<SbxReading>;
  /** Whether an agent runs on this machine at all: without one, SBX cannot be disabled. */
  anyAgentInstalled(): Promise<boolean>;
  settings(project: Project): Promise<SbxProjectSettings>;
  stored(projectId: string): Promise<SbxStoredLocal>;
  /** sbx-settings.ts's readProjectSbxProblems. */
  problems(
    project: Project,
    settings: SbxProjectSettings,
    skills: SbxSkillsSettings,
    values: Pick<SbxStoredLocal, "environment">,
    reading?: SbxReading,
  ): Promise<SbxProblems>;
  /** sbx-settings.ts's saveProjectSbx: takes the status's organization, and lists the rest in its turn. */
  save(project: Project, request: SbxProjectSettings, local: SbxLocalSave, known?: Pick<SbxReading, "status">): Promise<SbxSaveResult>;
  /** The access tokens kept for every project (sbx-accounts.ts), never a token. */
  accounts(): SbxAccount[];
  /** sbx-status.ts's readSbxSignedIn: one `sbx ls`, not the whole status — the question is the
   *  machine's. */
  signedIn(): Promise<boolean>;
  /** sbx-cli.ts's readSbxUser: only once signedIn said so. */
  signedInUser(): Promise<string | undefined>;
  /** sbx-accounts.ts's signInToSbx with the token kept for that account. */
  signIn(account: SbxAccount): Promise<SbxSignInResult>;
  /** sbx-mcp.ts's readRegisteredMcp; undefined when sbx cannot say. */
  mcpRegistered(): Promise<SbxRegisteredMcp[] | undefined>;
  /** sbx-mcp.ts's signInMcp: opens the browser and waits; what sbx said on refusing. */
  mcpSignIn(name: string): Promise<string | undefined>;
}

/** What sbxAccess reads from and stores into. */
export interface SbxAccessDeps {
  sbxLocal: SbxLocalStore;
  sbxAccounts: SbxAccountStore;
  notice: (severity: NoticeSeverity, message: string) => void;
  /** requirements.ts's. */
  anyAgentInstalled: () => Promise<boolean>;
}

/** The SbxAccess of this machine's sbx. */
export function sbxAccess({ sbxLocal, sbxAccounts, notice, anyAgentInstalled }: SbxAccessDeps): SbxAccess {
  return {
    // No PATH re-read: tet-ctl follows no install, the dialog's "Check again" does.
    status: (project) => readSbxReading(project.path, { projectId: project.id }, false),
    anyAgentInstalled,
    settings: (project) => readSbxSettings(project.path),
    stored: (projectId) => sbxLocal.stored(projectId),
    problems: readProjectSbxProblems,
    save: (project, request, local, known) => saveProjectSbx({ sbxLocal, notice }, project, request, local, known),
    accounts: () => sbxAccounts.list(),
    signedIn: readSbxSignedIn,
    signedInUser: () => readSbxUser(false),
    signIn: (account) => signInToSbx(sbxAccounts, account.user, "", account.id),
    mcpRegistered: () => readRegisteredMcp(),
    mcpSignIn: signInMcp,
  };
}
