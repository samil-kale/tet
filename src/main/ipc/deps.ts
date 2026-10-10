import type { NoticeSeverity } from "../../shared/types/app";
import type { ControlRecords } from "../ctl/ctl-records";
import type { EnvRequests } from "../ctl/env-requests";
import type { EnvStore } from "../store/environment";
import type { GitLoginStore } from "../git/git-logins";
import type { RepositoryManager } from "../git/repository";
import type { ProjectDeps } from "../projects";
import type { ProjectStore } from "../store/project-store";
import type { AccountStore } from "../providers/accounts";
import type { SbxAccountStore } from "../sbx/sbx-accounts";
import type { SbxLocalStore } from "../sbx/sbx-local";
import type { SettingsAccess } from "../store/settings";
import type { SessionManagerRegistry } from "../terminals/session-registry";

/** The singletons main.ts builds, for the renderer-facing IPC surface. */
export interface IpcDeps {
  store: ProjectStore;
  settings: SettingsAccess;
  accounts: AccountStore;
  /** The logins typed into TET for git hosts without a credential helper. */
  logins: GitLoginStore;
  sbxLocal: SbxLocalStore;
  sbxAccounts: SbxAccountStore;
  environment: EnvStore;
  /** Shared with the control channel's `env-request`. */
  envRequests: EnvRequests;
  repositories: RepositoryManager;
  tabManagers: SessionManagerRegistry;
  /** The window's reports for the control verbs. */
  records: ControlRecords;
  /** Shared with the control channel (main.ts). */
  projectDeps: ProjectDeps;
  /** Tells the user (Notices.tsx), as main.ts does; a handler with a dialog up answers it instead. */
  notice: (severity: NoticeSeverity, message: string) => void;
  /** Opens the stored projects, once, when the requirements are met; resolves once their ids are
   *  read, so the window's first list has them. */
  openWorkspace: () => Promise<void>;
  /** main.ts's one way out, shared with the control channel's `app-restart`. */
  shutdown: (relaunch: boolean) => void;
}
