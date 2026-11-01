import { handle } from "./channels";
import { failure } from "../../shared/errors";
import type { ActionResult } from "../../shared/types/action";
import type { EnvAnswer, EnvEdit, EnvVarInfo } from "../../shared/types/environment";
import type { IpcDeps } from "./deps";

/** The environment dialog's answer and the Settings' Environment tab. */
export function registerEnvironmentIpc({ environment, envRequests }: Pick<IpcDeps, "environment" | "envRequests">): void {
  handle("env:list", (): EnvVarInfo[] => environment.list());
  // Both answer why they could not save, for the dialog to show; nothing once it went through.
  handle("env:save", (_event, rows: EnvEdit[]): ActionResult => {
    try {
      environment.edit(rows);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });
  handle("env:answer", (_event, id: number, answer: EnvAnswer[] | null): ActionResult => envRequests.answer(id, answer));
}
