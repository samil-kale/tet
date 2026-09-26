import * as fs from "node:fs";
import * as path from "node:path";
import { net, shell } from "electron";
import { ipcMain } from "electron";
import { errorMessage } from "../../shared/errors";
import type { ProjectRef } from "../../shared/types";
import { expandHome, repositoryRelative } from "../path-inside";
import { isExecutableFile, isOpenableUrl } from "../shell-open";
import type { IpcDeps } from "./deps";

/** A Markdown preview's web image: the editor's cap for a repository file (`Repository.readFile`),
 *  and a badge service that hangs is given up on. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FETCH_IMAGE_TIMEOUT_MS = 15_000;
/** As many hops as a badge service needs; past that it is a loop, not a move. */
const MAX_IMAGE_REDIRECTS = 5;

/** What `fetchHttpsImage` sends a request with; `net.fetch` in the app, a stand-in in the tests. */
type FetchLike = (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<Response>;

/**
 * Fetches `url` with every hop checked to be https, the whole chain under one timeout. Undefined
 * as soon as a hop is not https, names no location, or the chain runs long — a README's image must
 * not become a request to another scheme or to a host behind the machine.
 */
export async function fetchHttpsImage(url: string, fetchFn: FetchLike = net.fetch): Promise<Response | undefined> {
  const signal = AbortSignal.timeout(FETCH_IMAGE_TIMEOUT_MS);
  // A relative location resolves against the hop that sent it; undefined where it is no URL at all.
  const resolve = (value: string, base?: string): string | undefined => {
    try {
      const resolved = new URL(value, base);
      // A `javascript:` or `data:` location resolves to itself and is refused here, like `http:`.
      return resolved.protocol === "https:" ? resolved.href : undefined;
    } catch {
      return undefined;
    }
  };

  let target = resolve(url);
  for (let hop = 0; target !== undefined && hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const response = await fetchFn(target, { signal, redirect: "manual" });
    // 3xx without a location is not a redirect; anything else is the answer.
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location === null) {
      return response;
    }
    target = resolve(location, target);
  }
  return undefined;
}

/** What tet hands to the OS: links, files and folders. */
export function registerShellIpc({
  repositories,
  notice
}: Pick<IpcDeps, "repositories" | "notice">): void {
  /** Opens `target` with the OS's default app; a refusal is a notice naming it as `shown`. */
  const openWithNotice = async (target: string, kind: "file" | "folder", shown: string): Promise<void> => {
    const error = await shell.openPath(target);
    if (error) {
      notice("error", `Could not open ${kind}: ${shown} (${error})`);
    }
  };

  ipcMain.handle("shell:open-url", async (_event, url: string): Promise<void> => {
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
   * redirect names — the machine's own network included, which is what fetching here instead of
   * in the page was meant to prevent.
   */
  ipcMain.handle("shell:fetch-image", async (_event, url: string): Promise<string | null> => {
    try {
      const response = await fetchHttpsImage(url);
      if (!response) {
        return null;
      }
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
  ipcMain.handle("shell:open-file", async (_event, ref: ProjectRef, rawPath: string): Promise<string | null> => {
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
    if (isExecutableFile(resolved, stat.mode)) {
      shell.showItemInFolder(resolved);
      return null;
    }
    await openWithNotice(resolved, "file", rawPath);
    return null;
  });

  /** The git pane's "show in file manager". */
  ipcMain.handle("shell:reveal-file", (_event, ref: ProjectRef, filePath: string): void => {
    const repository = repositories.get(ref);
    if (repository) {
      shell.showItemInFolder(path.join(repository.at.path, filePath));
    }
  });

  /** "Open in external editor": no editor setting, so the OS default for the type. */
  ipcMain.handle("shell:open-file-externally", async (_event, ref: ProjectRef, filePath: string): Promise<void> => {
    const repository = repositories.get(ref);
    if (!repository) {
      return;
    }
    await openWithNotice(path.join(repository.at.path, filePath), "file", filePath);
  });

  ipcMain.handle("shell:open-project", async (_event, ref: ProjectRef): Promise<void> => {
    const repository = repositories.get(ref);
    if (!repository) {
      return;
    }
    await openWithNotice(repository.at.path, "folder", repository.at.path);
  });
}
