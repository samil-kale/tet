import { EMPTY_REPOSITORY_STATE } from "../../shared/types";
import type { NoticeSeverity, RepositoryState } from "../../shared/types";
import type { ControlRecords } from "../control/control-records";
import type { EnvRequests, EnvStore } from "../environment";
import type { GitLoginStore } from "../git-logins";
import type { RepositoryManager } from "../git/repository";
import type { ProjectDeps, ProjectStore } from "../projects";
import type { AccountStore } from "../providers/accounts";
import type { SbxAccountStore } from "../sbx-accounts";
import type { SbxLocalStore } from "../sbx-local";
import type { SettingsStore } from "../settings";
import type { SessionManagerRegistry } from "../terminals/session-manager";

/** The singletons main.ts builds, for the renderer-facing IPC surface. */
export interface IpcDeps {
  store: ProjectStore;
  settings: SettingsStore;
  accounts: AccountStore;
  /** The logins typed into tet for git hosts without a credential helper. */
  logins: GitLoginStore;
  sbxLocal: SbxLocalStore;
  sbxAccounts: SbxAccountStore;
  environment: EnvStore;
  /** Shared with the control channel's `env-request`. */
  envRequests: EnvRequests;
  repositories: RepositoryManager;
  sessions: SessionManagerRegistry;
  /** The window's reports for the control verbs. */
  records: ControlRecords;
  /** Shared with the control channel (main.ts). */
  projectDeps: ProjectDeps;
  /** Posts to the window, or nowhere while none is open. */
  send: (channel: string, payload: unknown) => void;
  /** Tells the user (Notices.tsx), as main.ts does; a handler with a dialog up answers it instead. */
  notice: (severity: NoticeSeverity, message: string) => void;
  /** Opens the stored projects, once, when the requirements are met; resolves once their ids are
   *  read, so the window's first list has them. */
  openWorkspace: () => Promise<void>;
  /** Returns whether a restart is still needed. */
  applyTheme: () => boolean;
  /** main.ts's one way out, shared with the control channel's `restart-app`. */
  shutdown: (relaunch: boolean) => void;
}

/** The answer of every verb addressed to a project that is not open. */
export const MISSING_REPOSITORY: RepositoryState = { ...EMPTY_REPOSITORY_STATE, error: "Repository not open" };

