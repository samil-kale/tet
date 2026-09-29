import * as fs from "node:fs";
import * as path from "node:path";
import { dropsDir, projectsDir, sandboxDirsOf, sandboxDropsDir } from "./project-dirs";
import { openInside } from "../util/path-inside";

const DROP_FILE_NAME = /^tet-(\d+)-/;
/** A pasted file is read within its turn; a day is generous. */
const DROP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Writes pathless renderer bytes into `dir` and returns the file's path. Never through a link out
 * of `dir`'s folder (openInside): a sandbox's `drops/` lies in its agent folder, which it sees
 * whole, while that folder itself is its mount and cannot be replaced.
 */
export async function writeDropFile(dir: string, name: string, data: Buffer): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `tet-${Date.now()}-${path.basename(name)}`);
  const handle = await openInside(path.dirname(dir), file, "wx");
  try {
    // Async: a screenshot is megabytes, and a sync write would stall pty output and keystrokes.
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
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
