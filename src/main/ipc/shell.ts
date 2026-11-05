import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import { handle } from "./channels";
import { MAX_EDIT_BYTES } from "../git/explorer-read";
import { errorMessage } from "../../shared/errors";
import type { ProjectRef } from "../../shared/types/project";
import { fetchHttpsImage, imageDataUrl } from "../util/image-response";
import { expandHome, repositoryRelative } from "../util/path-inside";
import { isExecutableFile, isOpenableUrl } from "../util/shell-open";
import type { IpcDeps } from "./deps";

/** What TET hands to the OS: links, files and folders. */
export function registerShellIpc({ repositories, notice }: Pick<IpcDeps, "repositories" | "notice">): void {
  /** Opens `target` with the OS's default app; a refusal is a notice naming it as `shown`. */
  const openWithNotice = async (target: string, kind: "file" | "folder", shown: string): Promise<void> => {
    const error = await shell.openPath(target);
    if (error) {
      notice("error", `Could not open ${kind}: ${shown} (${error})`);
    }
  };

  /** A file the same way, or shown in the file manager where its default app would run it. */
  const openFile = async (target: string, shown: string): Promise<void> => {
    const stat = await fs.promises.stat(target).catch(() => null);
    if (stat && isExecutableFile(target, stat.mode)) {
      shell.showItemInFolder(target);
      return;
    }
    await openWithNotice(target, "file", shown);
  };

  handle("shell:open-url", async (_event, url: string): Promise<void> => {
    if (!isOpenableUrl(url)) {
      notice("error", `Only http, https and mailto links are opened: ${url}`);
      return;
    }
    try {
      await shell.openExternal(url);
    } catch (error) {
      notice("error", `Could not open URL: ${url} (${errorMessage(error)})`);
    }
  });

  /**
   * A Markdown preview's web image as a data URL, fetched here so the page's CSP keeps it off the
   * network; null for anything that isn't an https image within the cap. `net.fetch` for the
   * machine's proxy and certificates, as `providers/provider.ts`.
   *
   * Redirects are followed by hand (`fetchHttpsImage`): a followed one is a fetch of its own, and
   * left to `net.fetch` it would carry a README's image off https and onto whatever host the
   * redirect names — the machine's own network included, which fetching here keeps it from.
   */
  handle("shell:fetch-image", async (_event, url: string): Promise<string | null> => {
    try {
      const response = await fetchHttpsImage(url);
      // The editor's cap for a repository file.
      return response ? await imageDataUrl(response, MAX_EDIT_BYTES) : null;
    } catch {
      return null;
    }
  });

  /**
   * A ctrl-clicked terminal path: inside the repository, its relative path for the editor tab;
   * otherwise opened by the OS here, or shown in the file manager if opening would run it.
   */
  handle("shell:open-file", async (_event, ref: ProjectRef, rawPath: string): Promise<string | null> => {
    const repository = repositories.get(ref);
    if (!repository) {
      return null;
    }
    const expanded = expandHome(rawPath);
    const root = repository.at.path;
    const resolved = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (!stat?.isFile()) {
      notice("error", `Could not find file: ${rawPath}`);
      return null;
    }
    const relative = repositoryRelative(root, resolved);
    if (relative !== undefined) {
      return relative;
    }
    await openFile(resolved, rawPath);
    return null;
  });

  /** A file menu's reveal, in the Explorer and the changes list (file-menu.ts's pathEntries). */
  handle("shell:reveal-file", (_event, ref: ProjectRef, filePath: string): void => {
    const repository = repositories.get(ref);
    if (repository) {
      shell.showItemInFolder(path.join(repository.at.path, filePath));
    }
  });

  /** "Open in external editor": no editor setting, so the OS default for the type. */
  handle("shell:open-file-externally", async (_event, ref: ProjectRef, filePath: string): Promise<void> => {
    const repository = repositories.get(ref);
    if (!repository) {
      return;
    }
    await openFile(path.join(repository.at.path, filePath), filePath);
  });

  handle("shell:open-project", async (_event, ref: ProjectRef): Promise<void> => {
    const repository = repositories.get(ref);
    if (!repository) {
      return;
    }
    await openWithNotice(repository.at.path, "folder", repository.at.path);
  });
}
