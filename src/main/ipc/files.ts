import * as fs from "node:fs";
import * as path from "node:path";
import { clipboard, ipcMain } from "electron";
import type { ProjectRef } from "../../shared/types";
import { dropsDir, projectsDir, sandboxDirsOf, sandboxDropsDir } from "../project-dirs";
import type { IpcDeps } from "./deps";

const DROP_FILE_NAME = /^tet-(\d+)-/;
/** A pasted file is read within its turn; a day is generous. */
const DROP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Writes pathless renderer bytes into `dir` and returns the file's path. */
async function writeDropFile(dir: string, name: string, data: Buffer): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `tet-${Date.now()}-${path.basename(name)}`);
  // Async: a screenshot is megabytes, and a sync write would stall pty output and keystrokes.
  await fs.promises.writeFile(file, data);
  return file;
}

/** Every drops folder: each project's (dropsDir) and each of its sandboxes' (sandboxDropsDir). */
async function dropsDirs(dataRoot: string): Promise<string[]> {
  const projectIds = await fs.promises.readdir(projectsDir(dataRoot)).catch((): string[] => []);
  return projectIds.flatMap((projectId) => [
    dropsDir(dataRoot, projectId),
    ...sandboxDirsOf(dataRoot, projectId).map(sandboxDropsDir)
  ]);
}

/**
 * Clears old writeDropFile files, at startup rather than per paste (a file may still be read). The
 * write time is in the name: one `readdir` per folder, no `stat`.
 */
export function sweepDropFiles(dataRoot: string): void {
  void (async () => {
    const cutoff = Date.now() - DROP_FILE_MAX_AGE_MS;
    for (const dir of await dropsDirs(dataRoot)) {
      const names = await fs.promises.readdir(dir).catch((): string[] => []);
      await Promise.all(
        names.map(async (name) => {
          const match = DROP_FILE_NAME.exec(name);
          if (!match || Number(match[1]) >= cutoff) {
            return;
          }
          await fs.promises.unlink(path.join(dir, name)).catch(() => undefined);
        })
      );
    }
  })();
}

/** What a paste or drop hands a tab: bytes without a path written into its drops folder, and every
 *  path — written or dropped — as the tab sees it (hand-paths), one way for both. */
export function registerFilesIpc({ sessions }: Pick<IpcDeps, "sessions">): void {
  /** The file written, on this machine; null when the tab's repository or worktree is closed. */
  const writeDrop = async (ref: ProjectRef, tabId: string, name: string, data: Buffer): Promise<string | null> => {
    const manager = sessions.get(ref);
    return manager ? writeDropFile(manager.dropsDir(tabId), name, data) : null;
  };

  ipcMain.handle(
    "files:write-drop",
    (_event, ref: ProjectRef, tabId: string, name: string, dataBase64: string): Promise<string | null> =>
      writeDrop(ref, tabId, name, Buffer.from(dataBase64, "base64"))
  );

  /** The clipboard image as a file, so its path can be typed into a CLI. */
  ipcMain.handle("files:clipboard-image", (_event, ref: ProjectRef, tabId: string): Promise<string | null> | null => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : writeDrop(ref, tabId, `pasted-image-${Date.now()}.png`, image.toPNG());
  });

  ipcMain.handle("files:hand-paths", async (_event, ref: ProjectRef, tabId: string, paths: string[]): Promise<string[]> => {
    return (await sessions.get(ref)?.handPaths(tabId, paths)) ?? [];
  });
}
