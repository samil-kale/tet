import { ipcMain } from "electron";
import { errorMessage } from "../../shared/errors";
import type { EnvAnswer, EnvEdit, EnvVarInfo } from "../../shared/types";
import type { IpcDeps } from "./deps";

/** The environment dialog's answer and the Settings' Environment tab. */
export function registerEnvironmentIpc({ environment, envRequests }: Pick<IpcDeps, "environment" | "envRequests">): void {
  ipcMain.handle("environment:list", (): EnvVarInfo[] => environment.list());
  // Both answer why they could not save, for the dialog to show; nothing once it went through.
  ipcMain.handle("environment:save", (_event, rows: EnvEdit[]): string | undefined => {
    try {
      environment.edit(rows);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  });
  ipcMain.handle("environment:answer", (_event, id: number, answer: EnvAnswer[] | null): string | undefined =>
    envRequests.answer(id, answer)
  );
}
