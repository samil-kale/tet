import { EMPTY_REPOSITORY_STATE } from "../../shared/types";
import type { Project, RepositoryState } from "../../shared/types";
import type { ControlRecords } from "../control/control-records";
import type { EnvRequests, EnvStore } from "../environment";
import type { RepositoryManager } from "../git/repository";
import type { ProjectDeps, ProjectStore } from "../projects";
import type { AccountStore } from "../providers/accounts";
import type { SbxSecretStore } from "../sbx-secrets";
import type { SettingsStore } from "../settings";
import type { SessionManagerRegistry } from "../terminals/session-manager";

/** The singletons main.ts builds, for the renderer-facing IPC surface. */
export interface IpcDeps {
  /** TET's data folder (data-root.ts). */
  dataRoot: string;
  store: ProjectStore;
  settings: SettingsStore;
  accounts: AccountStore;
  sbxSecrets: SbxSecretStore;
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
  /** Shared with the bootstrap's restore. */
  openProject: (project: Project) => void;
  /** Opens the stored projects, once, when the requirements are met. */
  openWorkspace: () => void;
  /** Returns whether a restart is still needed. */
  applyTheme: () => boolean;
  /** main.ts's one way out, shared with the control channel's `restart-app`. */
  shutdown: (relaunch: boolean) => void;
}

/** The answer of every verb addressed to a project that is not open. */
export const MISSING_REPOSITORY: RepositoryState = { ...EMPTY_REPOSITORY_STATE, error: "Project not found" };

