import { handle } from "./channels";
import { failure } from "../../shared/errors";
import type { ActionResult } from "../../shared/types/action";
import type { EnvAnswer, EnvEdit, EnvVarInfo } from "../../shared/types/environment";
import type { IpcDeps } from "./deps";

/** The environment dialog's answer and the Settings' Environment tab. */
export function registerEnvironmentIpc({
  environment,
  envRequests,
  settings,
}: Pick<IpcDeps, "environment" | "envRequests" | "settings">): void {
  handle("env:list", (): EnvVarInfo[] => environment.list());
  // Both answer why they could not save, for the dialog to show; nothing once it went through.
  handle("env:save", async (_event, rows: EnvEdit[], encryptValues: boolean): Promise<ActionResult> => {
    try {
      // The checkbox last: a machine without encryption refuses it with nothing changed.
      await environment.edit(rows, encryptValues);
      settings.patch({ environment: { encryptValues } });
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  });
  handle("env:answer", (_event, id: number, answer: EnvAnswer[] | null): Promise<ActionResult> => envRequests.answer(id, answer));
}
