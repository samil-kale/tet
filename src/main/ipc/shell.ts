import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { net, shell } from "electron";
import { ipcMain } from "electron";
import { repositoryRelative } from "../path-inside";
import { isExecutableFile, isOpenableUrl } from "../shell-open";
import type { IpcDeps } from "./deps";

/** A Markdown preview's web image: the editor's cap for a repository file (`Repository.readFile`),
 *  and a badge service that hangs is given up on. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FETCH_IMAGE_TIMEOUT_MS = 15_000;

/** What tet hands to the OS: links, files and folders. */
export function registerShellIpc({
  repositories,
  send
}: Pick<IpcDeps, "repositories" | "send">): void {
  ipcMain.handle("shell:open-url", async (_event, url: string): Promise<void> => {
    if (!isOpenableUrl(url)) {
      send("app:notice", { severity: "error", message: `Only http, https and mailto links are opened: ${url}` });
      return;
    }
    try {
      await shell.openExternal(url);
    } catch (error) {
      send("app:notice", { severity: "error", message: `Could not open URL: ${url} (${String(error)})` });
    }
  });

  /**
   * A Markdown preview's web image as a data URL, fetched here so the page's CSP keeps it off the
   * network; null for anything that isn't an https image within the cap. `net.fetch` for the
   * machine's proxy and certificates, as `providers/provider.ts`.
   */
  ipcMain.handle("shell:fetch-image", async (_event, url: string): Promise<string | null> => {
    try {
      if (new URL(url).protocol !== "https:") {
        return null;
      }
      const response = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_IMAGE_TIMEOUT_MS) });
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
      if (!response.ok || !type.startsWith("image/") || !response.body) {
        return null;
      }
      // Read in chunks against the cap: a response without a content-length would otherwise be
      // held whole before it could be measured. Leaving the loop cancels the rest.
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          return null;
        }
        chunks.push(chunk);
      }
      return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
    } catch {
      return null;
    }
  });

  /**
   * A ctrl-clicked terminal path: inside the repository, its relative path for the editor tab;
   * otherwise opened by the OS here, or shown in the file manager if opening would run it.
   */
  ipcMain.handle("shell:open-file", async (_event, projectId: string, rawPath: string): Promise<string | null> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return null;
    }
    const expanded =
      rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")
        ? path.join(os.homedir(), rawPath.slice(1))
        : rawPath;
    const root = repository.project.path;
    const resolved = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (!stat?.isFile()) {
      send("app:notice", { severity: "error", message: `Could not find file: ${rawPath}` });
      return null;
    }
    const relative = repositoryRelative(root, resolved);
    if (relative !== undefined) {
      return relative;
    }
    if (isExecutableFile(resolved, stat.mode)) {
      shell.showItemInFolder(resolved);
      return null;
    }
    const error = await shell.openPath(resolved);
    if (error) {
      send("app:notice", { severity: "error", message: `Could not open file: ${rawPath} (${error})` });
    }
    return null;
  });

  /** The git pane's "show in file manager". */
  ipcMain.handle("shell:reveal-file", (_event, projectId: string, filePath: string): void => {
    const repository = repositories.get(projectId);
    if (repository) {
      shell.showItemInFolder(path.join(repository.project.path, filePath));
    }
  });

  /** "Open in external editor": no editor setting, so the OS default for the type. */
  ipcMain.handle("shell:open-file-externally", async (_event, projectId: string, filePath: string): Promise<void> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return;
    }
    const error = await shell.openPath(path.join(repository.project.path, filePath));
    if (error) {
      send("app:notice", { severity: "error", message: `Could not open file: ${filePath} (${error})` });
    }
  });

  ipcMain.handle("shell:open-project", async (_event, projectId: string): Promise<void> => {
    const repository = repositories.get(projectId);
    if (!repository) {
      return;
    }
    const error = await shell.openPath(repository.project.path);
    if (error) {
      send("app:notice", { severity: "error", message: `Could not open folder: ${repository.project.path} (${error})` });
    }
  });
}
