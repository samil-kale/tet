import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clipboard, ipcMain } from "electron";

const TEMP_FILE_NAME = /^tet-(\d+)-/;
/** A pasted file is read within its turn; a day is generous. */
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Writes pathless renderer bytes to a temp file and returns its path. */
async function writeTempFile(name: string, data: Buffer): Promise<string> {
  const file = path.join(os.tmpdir(), `tet-${Date.now()}-${path.basename(name)}`);
  // Async: a screenshot is megabytes, and a sync write would stall pty output and keystrokes.
  await fs.promises.writeFile(file, data);
  return file;
}

/**
 * Clears old writeTempFile files, at startup rather than per paste (a file may still be read). The
 * write time is in the name: one `readdir`, no `stat`.
 */
export function sweepTempFiles(): void {
  void (async () => {
    const dir = os.tmpdir();
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
    await Promise.all(
      names.map(async (name) => {
        const match = TEMP_FILE_NAME.exec(name);
        if (!match || Number(match[1]) >= cutoff) {
          return;
        }
        await fs.promises.unlink(path.join(dir, name)).catch(() => undefined);
      })
    );
  })();
}

/** Bytes the renderer has but no path for: a paste, a drop, the clipboard's image. */
export function registerFilesIpc(): void {
  ipcMain.handle("files:write-temp", (_event, name: string, dataBase64: string): Promise<string> => {
    return writeTempFile(name, Buffer.from(dataBase64, "base64"));
  });

  /** The clipboard image as a file, so its path can be typed into a CLI. */
  ipcMain.handle("clipboard:image-file", (): Promise<string> | null => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : writeTempFile(`pasted-image-${Date.now()}.png`, image.toPNG());
  });
}
