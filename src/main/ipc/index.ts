import { registerAppIpc } from "./app";
import { registerCommandsIpc } from "./commands";
import { registerEnvironmentIpc } from "./environment";
import type { IpcDeps } from "./deps";
import { registerFilesIpc } from "./files";
import { registerProjectsIpc } from "./projects";
import { registerRepositoryIpc } from "./repository";
import { registerSbxIpc } from "./sbx";
import { registerShellIpc } from "./shell";
import { registerTerminalsIpc } from "./terminals";

export type { IpcDeps } from "./deps";
export { sweepTempFiles } from "./files";

/** The renderer-facing surface, one registrar per group of `TETApi` (`src/shared/api.ts`). Each
 *  takes only the singletons it touches, so what a group reaches is visible at its signature. */
export function registerIpc(deps: IpcDeps): void {
  registerAppIpc(deps);
  registerSbxIpc(deps);
  registerEnvironmentIpc(deps);
  registerProjectsIpc(deps);
  registerRepositoryIpc(deps);
  registerCommandsIpc(deps);
  registerTerminalsIpc(deps);
  registerShellIpc(deps);
  registerFilesIpc();
}
