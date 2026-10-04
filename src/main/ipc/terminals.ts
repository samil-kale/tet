import { handle, on } from "./channels";
import type { AgentId } from "../../shared/types/agents";
import type { EditorReport, NoticeReport } from "../../shared/types/app";
import type { GitActionResult } from "../../shared/types/git";
import type { ProjectRef } from "../../shared/types/project";
import type { HandoverResult, TabDescriptor } from "../../shared/types/terminals";
import { notOpenMessage } from "../store/resolved-ref";
import type { IpcDeps } from "./deps";

/** The tab strip: the terminals themselves, plus what only the renderer knows about its editor
 *  tabs and shown notices. */
export function registerTerminalsIpc({
  store,
  tabManagers,
  records
}: Pick<IpcDeps, "store" | "tabManagers" | "records">): void {
  handle("tabs:list", (_event, ref: ProjectRef): TabDescriptor[] => {
    return tabManagers.get(ref)?.snapshot() ?? [];
  });

  handle("tabs:create", (_event, ref: ProjectRef, agentId: AgentId): TabDescriptor => {
    const manager = tabManagers.get(ref);
    if (!manager) {
      throw new Error(notOpenMessage(store, ref));
    }
    return manager.createTab(agentId);
  });

  handle("tabs:close", async (_event, ref: ProjectRef, tabIds: string[]): Promise<void> => {
    await tabManagers.get(ref)?.closeTabs(tabIds);
  });

  handle(
    "tabs:rename",
    async (_event, ref: ProjectRef, tabId: string, title: string): Promise<GitActionResult> => {
      const refused = await tabManagers.get(ref)?.renameTab(tabId, title);
      return refused === undefined ? { ok: true } : { ok: false, error: refused };
    }
  );

  handle(
    "tabs:handover",
    async (_event, ref: ProjectRef, tabId: string, agentId: AgentId): Promise<HandoverResult> => {
      const handed = (await tabManagers.get(ref)?.handOver(tabId, agentId)) ?? notOpenMessage(store, ref);
      return typeof handed === "string" ? { ok: false, error: handed } : { ok: true, tab: handed };
    }
  );

  // The window's restart (the tab menu, the environment dialog): a running tab quits first.
  handle("tabs:restart", (_event, ref: ProjectRef, tabId: string): void => {
    tabManagers.get(ref)?.restartTab(tabId, true);
  });

  /** The tab is on screen: clears its finished-turn mark. Only the renderer knows. */
  on("tabs:seen", (_event, ref: ProjectRef, tabId: string) => {
    tabManagers.get(ref)?.markSeen(tabId);
  });

  /** The editor tabs and shown notices, for tet-ctl — only the renderer knows. */
  on("editor:report", (_event, ref: ProjectRef, tabId: string, report: EditorReport | null) => {
    records.setEditor(ref, tabId, report);
  });
  on("editor:active", (_event, ref: ProjectRef, tabId: string) => {
    records.setActiveEditor(ref, tabId);
  });

  on("app:notice-shown", (_event, report: NoticeReport) => {
    records.addNotice(report);
  });

  /** Tabs on screen get no turn notification. Only the renderer knows them. */
  on("tabs:on-screen", (_event, ref: ProjectRef | null, tabIds: string[]) => {
    tabManagers.setOnScreen(ref, tabIds);
  });

  on("tabs:input", (_event, ref: ProjectRef, tabId: string, data: string) => {
    tabManagers.get(ref)?.write(tabId, data);
  });

  on("tabs:resize", (_event, ref: ProjectRef, tabId: string, cols: number, rows: number) => {
    tabManagers.get(ref)?.handleResize(tabId, cols, rows);
  });

  handle("tabs:starting", (_event, ref: ProjectRef): boolean => {
    return tabManagers.get(ref)?.isStarting() ?? false;
  });

}
