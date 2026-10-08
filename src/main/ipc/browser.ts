import { handle, on } from "./channels";
import { errorMessage } from "../../shared/errors";
import { browserUrl } from "../browser/browser-tabs";
import type { BrowserBounds, BrowserCredentials, BrowserEdit, BrowserGo, BrowserTabInfo } from "../../shared/types/browser";
import type { ProjectRef } from "../../shared/types/project";
import type { IpcDeps } from "./deps";

/** The browser tabs: their pages are main's (browser/browser-tabs.ts), the window draws their box. */
export function registerBrowserIpc({ browserTabs, notice }: Pick<IpcDeps, "browserTabs" | "notice">): void {
  handle("browser:list", (_event, ref: ProjectRef): BrowserTabInfo[] => browserTabs.list(ref));

  handle("browser:create", (_event, ref: ProjectRef, url: string): BrowserTabInfo => {
    const { tab, loaded } = browserTabs.create(ref, url);
    // A page that cannot load says so itself (did-fail-load).
    loaded.catch(() => undefined);
    return tab;
  });

  handle("browser:close", (_event, ref: ProjectRef, tabId: string): void => browserTabs.close(ref, tabId));

  // A page that cannot load says so itself (did-fail-load); an address that is none does not.
  on("browser:navigate", (_event, ref: ProjectRef, tabId: string, url: string) => {
    try {
      browserUrl(url);
    } catch (error) {
      notice("warning", `Could not open ${url}: ${errorMessage(error)}`);
      return;
    }
    browserTabs.navigate(ref, tabId, url).catch(() => undefined);
  });

  on("browser:go", (_event, ref: ProjectRef, tabId: string, where: BrowserGo) => browserTabs.go(ref, tabId, where));

  on("browser:edit", (_event, ref: ProjectRef, tabId: string, edit: BrowserEdit) => browserTabs.edit(ref, tabId, edit));

  on("browser:inspect", (_event, ref: ProjectRef, tabId: string, x: number, y: number) => browserTabs.inspect(ref, tabId, x, y));

  on("browser:answer-login", (_event, id: number, login: BrowserCredentials | null) => browserTabs.answerLogin(id, login));

  on("browser:place", (_event, ref: ProjectRef, tabId: string, bounds: BrowserBounds | null) => browserTabs.place(ref, tabId, bounds));

  on("browser:active", (_event, ref: ProjectRef, tabId: string) => browserTabs.setActive(ref, tabId));

  on("browser:raise", (_event, raised: boolean) => browserTabs.raise(raised));
}
