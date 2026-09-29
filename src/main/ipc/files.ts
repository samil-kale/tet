import { clipboard } from "electron";
import { handle } from "./channels";
import type { ProjectRef } from "../../shared/types";
import { writeDropFile } from "../store/drops";
import type { IpcDeps } from "./deps";

/** What a paste or drop hands a tab: bytes without a path written into its drops folder, and every
 *  path — written or dropped — as the tab sees it (hand-paths), one way for both. */
export function registerFilesIpc({ sessions }: Pick<IpcDeps, "sessions">): void {
  /** The file written, on this machine; null when the tab's repository or worktree is closed. */
  const writeDrop = async (ref: ProjectRef, tabId: string, name: string, data: Buffer): Promise<string | null> => {
    const manager = sessions.get(ref);
    return manager ? writeDropFile(manager.dropsDir(tabId), name, data) : null;
  };

  handle(
    "files:write-drop",
    (_event, ref: ProjectRef, tabId: string, name: string, dataBase64: string): Promise<string | null> =>
      writeDrop(ref, tabId, name, Buffer.from(dataBase64, "base64"))
  );

  /** The clipboard image as a file, so its path can be typed into a CLI. */
  handle("files:clipboard-image", (_event, ref: ProjectRef, tabId: string): Promise<string | null> | null => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : writeDrop(ref, tabId, `pasted-image-${Date.now()}.png`, image.toPNG());
  });

  handle("files:hand-paths", async (_event, ref: ProjectRef, tabId: string, paths: string[]): Promise<string[]> => {
    return (await sessions.get(ref)?.handPaths(tabId, paths)) ?? [];
  });
}
