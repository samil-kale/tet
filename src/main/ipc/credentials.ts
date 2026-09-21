import { ipcMain } from "electron";
import type { CredentialAnswer, CredentialInfo } from "../../shared/types";
import type { IpcDeps } from "./deps";

/** The credential dialog's answer and the Settings' Credentials tab. */
export function registerCredentialsIpc({
  credentials,
  credentialRequests
}: Pick<IpcDeps, "credentials" | "credentialRequests">): void {
  ipcMain.handle("credentials:list", (): CredentialInfo[] => credentials.list());
  ipcMain.handle("credentials:remove", (_event, name: string): void => void credentials.remove(name));
  // Why it could not be saved, for the dialog to show; nothing once it went through.
  ipcMain.handle("credentials:answer", (_event, id: number, answer: CredentialAnswer | null): string | undefined =>
    credentialRequests.answer(id, answer)
  );
}
